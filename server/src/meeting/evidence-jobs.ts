import { evidenceHash, evidenceJson, type EvidenceVault } from "./evidence-vault";

export type EvidenceJob = {
  kind: "roster" | "daily";
  workspace: string;
  meeting: string;
  room: string;
  actor: string;
  at: string;
};

const scope = { workspace: "evidence-jobs", meeting: "finalization" };
const keyFor = (job: EvidenceJob) => evidenceHash(evidenceJson([job.kind, job.workspace, job.meeting])).toString("hex");

export class EvidenceJobs {
  private running?: Promise<void>;

  constructor(private readonly vault: EvidenceVault, private readonly finalize: (job: EvidenceJob) => Promise<void>) {}

  async enqueue(job: EvidenceJob) {
    await this.vault.create(scope, `pending/${keyFor(job)}`, evidenceJson(job));
  }

  resume() {
    this.running ??= this.drain().finally(() => { this.running = undefined; });
    return this.running;
  }

  start() {
    const tick = () => void this.resume().catch(() => {
      console.error("[meeting-evidence] 无法读取封存队列");
    });
    const timer = setInterval(tick, 30_000);
    timer.unref();
    tick();
  }

  private async drain() {
    const [pending, finished] = await Promise.all([this.vault.list(scope, "pending"), this.vault.list(scope, "finished")]);
    const complete = new Set(finished);
    for (const key of pending) {
      if (complete.has(key) || !/^[a-f0-9]{64}$/u.test(key)) continue;
      try {
        const bytes = await this.vault.read(scope, `pending/${key}`);
        if (!bytes) continue;
        const job = JSON.parse(bytes.toString("utf8")) as EvidenceJob;
        if (keyFor(job) !== key) throw new Error("会议封存任务标识无效");
        await this.finalize(job);
        await this.vault.create(scope, `finished/${key}`, Buffer.from("完成"));
      } catch {
        console.error("[meeting-evidence] 会议存证封存失败，将重试", { job: key });
      }
    }
  }
}
