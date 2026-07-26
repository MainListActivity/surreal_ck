import {
  NATIVE_QUOTA_EXPECTED_CONTRACT,
  validateNativeQuotaCapability,
  type NativeQuotaCapabilityDiagnosticCode,
  type NativeQuotaCapabilityDocument,
  type NativeQuotaInfo,
} from "@surreal-ck/shared/native-quota";
import { env } from "../../env";
import { getRootConnection } from "../root-connection";
import {
  SurrealNativeQuotaClient,
  type NativeQuotaClient,
} from "./client";

const PROBE_TIMEOUT_MS = 5_000;

export type NativeQuotaStartupStage = "capability" | "readiness" | "root_info";

export class NativeQuotaStartupGateError extends Error {
  constructor(
    readonly stage: NativeQuotaStartupStage,
    readonly diagnosticCode: NativeQuotaCapabilityDiagnosticCode | "request_failed" | "invalid_info",
    readonly diagnostics: string[],
    options?: ErrorOptions,
  ) {
    super(
      `Native quota startup gate failed at ${stage}: ${diagnosticCode}`,
      options,
    );
    this.name = "NativeQuotaStartupGateError";
  }
}

function endpointUrl(surrealUrl: string, endpoint: "capabilities" | "ready"): URL {
  const url = new URL(surrealUrl);
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported SurrealDB URL protocol: ${url.protocol}`);
  }

  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/rpc\/?$/, "/");
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  url.pathname += endpoint;
  if (endpoint === "ready") {
    url.searchParams.set("require", NATIVE_QUOTA_EXPECTED_CONTRACT.capabilityName);
  }
  return url;
}

export function nativeQuotaProbeUrls(surrealUrl: string): {
  capability: URL;
  readiness: URL;
} {
  return {
    capability: endpointUrl(surrealUrl, "capabilities"),
    readiness: endpointUrl(surrealUrl, "ready"),
  };
}

async function fetchWithTimeout(
  fetcher: typeof fetch,
  url: URL,
): Promise<Response> {
  return fetcher(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
}

export async function probeNativeQuotaHttp(input: {
  surrealUrl?: string;
  production?: boolean;
  fetcher?: typeof fetch;
} = {}): Promise<NativeQuotaCapabilityDocument> {
  const urls = nativeQuotaProbeUrls(input.surrealUrl ?? env.SURREAL_URL);
  const fetcher = input.fetcher ?? fetch;

  let capabilityResponse: Response;
  try {
    capabilityResponse = await fetchWithTimeout(fetcher, urls.capability);
  } catch (cause) {
    throw new NativeQuotaStartupGateError(
      "capability",
      "request_failed",
      [urls.capability.toString()],
      { cause },
    );
  }
  if (!capabilityResponse.ok) {
    throw new NativeQuotaStartupGateError(
      "capability",
      "request_failed",
      [`${urls.capability} returned HTTP ${capabilityResponse.status}`],
    );
  }

  let document: unknown;
  try {
    document = await capabilityResponse.json();
  } catch (cause) {
    throw new NativeQuotaStartupGateError(
      "capability",
      "invalid_document",
      ["capability response is not JSON"],
      { cause },
    );
  }

  const validation = validateNativeQuotaCapability(document, {
    production: input.production ?? env.NODE_ENV === "production",
  });
  if (!validation.ok) {
    throw new NativeQuotaStartupGateError(
      "capability",
      validation.code,
      validation.issues,
    );
  }

  let readinessResponse: Response;
  try {
    readinessResponse = await fetchWithTimeout(fetcher, urls.readiness);
  } catch (cause) {
    throw new NativeQuotaStartupGateError(
      "readiness",
      "request_failed",
      [urls.readiness.toString()],
      { cause },
    );
  }
  if (!readinessResponse.ok) {
    throw new NativeQuotaStartupGateError(
      "readiness",
      "request_failed",
      [`${urls.readiness} returned HTTP ${readinessResponse.status}`],
    );
  }

  return validation.capability;
}

export async function verifyNativeQuotaRootHandshake(
  input: {
    client?: Pick<NativeQuotaClient, "info">;
    database?: string;
  } = {},
): Promise<NativeQuotaInfo> {
  const database = input.database ?? "_system";
  const client = input.client ?? new SurrealNativeQuotaClient(getRootConnection());
  let info: NativeQuotaInfo;
  try {
    info = await client.info(database);
  } catch (cause) {
    throw new NativeQuotaStartupGateError(
      "root_info",
      "invalid_info",
      [`quota INFO failed for ${database}`],
      { cause },
    );
  }

  const diagnostics = [
    info.format_version === NATIVE_QUOTA_EXPECTED_CONTRACT.infoFormatVersion
      ? null
      : `format_version=${info.format_version}`,
    info.database === database ? null : `database=${info.database}`,
    info.ledger.state === "ready" ? null : `ledger.state=${info.ledger.state}`,
    info.ledger.usage_trusted ? null : "ledger.usage_trusted=false",
    info.usage === null ? "usage is unavailable" : null,
  ].filter((diagnostic): diagnostic is string => diagnostic !== null);
  if (diagnostics.length > 0) {
    throw new NativeQuotaStartupGateError(
      "root_info",
      "invalid_info",
      diagnostics,
    );
  }

  return info;
}
