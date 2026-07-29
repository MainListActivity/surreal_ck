import { readFile, writeFile } from "node:fs/promises";
import {
  QUOTA_MIGRATION_COHORTS,
  QuotaMigrationAssignmentSchema,
  QuotaMigrationCohortSchema,
} from "@surreal-ck/shared/native-quota";
import { DateTime } from "surrealdb";
import {
  QuotaMigrationError,
  migrationChecksum,
} from "./model";

type CliOptions = Readonly<Record<string, string | boolean>>;

function parseArgs(args: readonly string[]): Readonly<{
  command: string;
  options: CliOptions;
}> {
  const [command = "help", ...rest] = args;
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (!arg.startsWith("--")) {
      throw new QuotaMigrationError(
        "migration_cli_argument_invalid",
        `unexpected positional argument: ${arg}`,
      );
    }
    const key = arg.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index += 1;
  }
  return { command, options };
}

function required(options: CliOptions, key: string): string {
  const value = options[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new QuotaMigrationError(
      "migration_cli_argument_missing",
      `missing required --${key}`,
    );
  }
  return value;
}

async function jsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

function dateTime(options: CliOptions, key: string): DateTime {
  return new DateTime(required(options, key));
}

function json(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, current) =>
      typeof current === "bigint" ? current.toString() : current,
    2,
  );
}

function help(): string {
  return `Native quota legacy migration conductor

Commands:
  inventory --run ID --draft assignments.json --out inventory.json
  checksum --file approved-manifest-without-checksum.json
  import --run ID --manifest approved-manifest.json
  prepare --run ID --evidence maintenance-evidence.json
  assert-reopen --run ID
  cutover --run ID --cohort ${QUOTA_MIGRATION_COHORTS.join("|")}
  complete-cohort --run ID --cohort ${QUOTA_MIGRATION_COHORTS.join("|")}
  signal --run ID --signal signal.json [--cohort COHORT]
  pause --run ID --reason TEXT
  resume --run ID
  abort --run ID --reason TEXT
  cleanup-evidence --run ID --full-audit-clean-at ISO
    --product-stable-since ISO --pre-native-blocked-at ISO
  cleanup-ready --run ID
  status --run ID

The CLI exits non-zero on every fail-closed gate. A successful prepare or
assert-reopen is the only evidence that WSS may be reopened.`;
}

export async function runQuotaMigrationCli(
  args = process.argv.slice(2),
): Promise<void> {
  const { command, options } = parseArgs(args);
  if (command === "help" || options.help === true) {
    console.info(help());
    return;
  }
  if (command === "checksum") {
    const document = await jsonFile(required(options, "file"));
    if (typeof document !== "object" || document === null) {
      throw new QuotaMigrationError(
        "migration_checksum_document_invalid",
        "checksum input must be a JSON object",
      );
    }
    const { checksum: _checksum, ...unsigned } = document as Record<
      string,
      unknown
    >;
    console.info(migrationChecksum(unsigned));
    return;
  }

  const [
    { ensureSystemSchema },
    rootConnection,
    nativeStartup,
    { seedQuotaPlans },
    { SurrealQuotaControlPlaneStore },
    { SurrealEntitlementRefreshService },
    { QuotaReconciler },
    { MaterializationWorker },
    { SurrealNativeQuotaClient },
    { env },
    {
      DurableQuotaMigrationPolicyActivator,
      LegacyQuotaMigrationConductor,
    },
    { SurrealQuotaMigrationStore },
  ] = await Promise.all([
    import("../db/system-schema"),
    import("../db/root-connection"),
    import("../db/native-quota/startup-gate"),
    import("../db/quota-plan-seed"),
    import("../quota/control-plane-store"),
    import("../quota/entitlement-refresh"),
    import("../quota/reconciler"),
    import("../quota/sweeps"),
    import("../db/native-quota/client"),
    import("../env"),
    import("./conductor"),
    import("./store"),
  ]);
  const {
    closeRootConnection,
    getRootConnection,
    getRootDatabaseSession,
    initRootConnection,
  } = rootConnection;
  const {
    probeNativeQuotaHttp,
    verifyNativeQuotaRootHandshake,
  } = nativeStartup;
  await probeNativeQuotaHttp({ production: env.NODE_ENV === "production" });
  await initRootConnection();
  try {
    await verifyNativeQuotaRootHandshake();
    await ensureSystemSchema();
    await seedQuotaPlans();

    const db = getRootConnection();
    const migrationStore = new SurrealQuotaMigrationStore(db);
    const controlStore = new SurrealQuotaControlPlaneStore(db);
    const native = new SurrealNativeQuotaClient(db);
    const materialization = new MaterializationWorker(
      controlStore,
      new QuotaReconciler(controlStore, native),
      `quota-migration-cli:${process.pid}`,
    );
    const conductor = new LegacyQuotaMigrationConductor(
      migrationStore,
      async (database) =>
        await getRootDatabaseSession(database, env.SURREAL_NS),
      new SurrealEntitlementRefreshService(db),
      new DurableQuotaMigrationPolicyActivator(
        migrationStore,
        materialization,
      ),
      { workerId: `quota-migration-cli:${process.pid}` },
    );
    const runKey = required(options, "run");

    switch (command) {
      case "inventory": {
        const draft = await jsonFile(required(options, "draft"));
        const values = Array.isArray(draft)
          ? draft
          : typeof draft === "object"
              && draft !== null
              && "assignments" in draft
              && Array.isArray(draft.assignments)
          ? draft.assignments
          : [];
        const draftAssignments = values.map((value) =>
          QuotaMigrationAssignmentSchema.parse(value)
        );
        const inventory = await conductor.createInventory({
          runId: runKey,
          namespace: env.SURREAL_NS,
          draftAssignments,
        });
        const output = required(options, "out");
        await writeFile(output, `${json(inventory)}\n`, {
          encoding: "utf8",
          flag: "wx",
        });
        console.info(json({
          kind: "inventory_written",
          path: output,
          checksum: inventory.checksum,
          workspaces: inventory.workspaces.length,
          blockers: inventory.workspaces.flatMap((workspace) =>
            workspace.anomalies.filter(
              (anomaly) => anomaly.severity === "blocker",
            )
          ).length,
        }));
        break;
      }
      case "import": {
        await conductor.importApprovedManifest(
          runKey,
          await jsonFile(required(options, "manifest")),
        );
        console.info(json({ kind: "manifest_imported", run: runKey }));
        break;
      }
      case "prepare": {
        await conductor.prepareNativeEnforcement(
          runKey,
          await jsonFile(required(options, "evidence")),
        );
        console.info(json({
          kind: "public_reopen_gate_passed",
          run: runKey,
        }));
        break;
      }
      case "assert-reopen": {
        await conductor.assertPublicReopenReady(runKey);
        console.info(json({
          kind: "public_reopen_gate_passed",
          run: runKey,
        }));
        break;
      }
      case "cutover": {
        const cohort = QuotaMigrationCohortSchema.parse(
          required(options, "cohort"),
        );
        const observeUntil = await conductor.cutoverCohort(runKey, cohort);
        console.info(json({
          kind: "cohort_observing",
          run: runKey,
          cohort,
          observe_until: observeUntil.toString(),
        }));
        break;
      }
      case "complete-cohort": {
        const cohort = QuotaMigrationCohortSchema.parse(
          required(options, "cohort"),
        );
        await conductor.completeCohort(runKey, cohort);
        console.info(json({
          kind: "cohort_completed",
          run: runKey,
          cohort,
        }));
        break;
      }
      case "signal": {
        const cohort = typeof options.cohort === "string"
          ? QuotaMigrationCohortSchema.parse(options.cohort)
          : undefined;
        await conductor.recordSignal(
          runKey,
          cohort,
          await jsonFile(required(options, "signal")),
        );
        console.info(json({ kind: "signal_recorded", run: runKey, cohort }));
        break;
      }
      case "pause":
        await conductor.pause(runKey, required(options, "reason"));
        console.info(json({ kind: "migration_paused", run: runKey }));
        break;
      case "resume":
        await conductor.resume(runKey);
        console.info(json({ kind: "migration_resumed", run: runKey }));
        break;
      case "abort":
        await conductor.abort(runKey, required(options, "reason"));
        console.info(json({ kind: "migration_aborted", run: runKey }));
        break;
      case "cleanup-evidence": {
        const cleanupNotBefore = await conductor.recordCleanupEvidence(
          runKey,
          {
            fullAuditCleanAt: dateTime(options, "full-audit-clean-at"),
            productReleaseStableSince: dateTime(
              options,
              "product-stable-since",
            ),
            preNativeCompatibilityBlockedAt: dateTime(
              options,
              "pre-native-blocked-at",
            ),
          },
        );
        console.info(json({
          kind: "cleanup_observation_started",
          run: runKey,
          cleanup_not_before: cleanupNotBefore.toString(),
        }));
        break;
      }
      case "cleanup-ready":
        await conductor.markCleanupEligible(runKey);
        console.info(json({ kind: "cleanup_eligible", run: runKey }));
        break;
      case "status": {
        const run = await migrationStore.findRun(runKey);
        if (!run) {
          throw new QuotaMigrationError(
            "migration_run_not_found",
            "quota migration run does not exist",
          );
        }
        const operations = await migrationStore.listOperations(run.id);
        console.info(json({
          run,
          workspaces: operations.map((operation) => ({
            workspace: operation.workspace.toString(),
            slug: operation.slug,
            database: operation.database,
            state: operation.state,
            cohort: operation.cohort,
            observed_generation: operation.observedGeneration,
            observed_digest: operation.observedDigest,
          })),
        }));
        break;
      }
      default:
        throw new QuotaMigrationError(
          "migration_cli_command_unknown",
          `unknown command: ${command}`,
        );
    }
  } finally {
    await closeRootConnection();
  }
}

if (import.meta.main) {
  try {
    await runQuotaMigrationCli();
  } catch (error) {
    const code = error instanceof QuotaMigrationError
      ? error.code
      : "migration_cli_failed";
    console.error(json({
      kind: "migration_error",
      code,
      message: error instanceof Error ? error.message : String(error),
      details: error instanceof QuotaMigrationError ? error.details : {},
    }));
    process.exitCode = 1;
  }
}
