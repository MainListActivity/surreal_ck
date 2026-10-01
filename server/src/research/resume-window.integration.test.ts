import { test, expect } from "bun:test";
import { Surreal } from "surrealdb";
import { loadTemplateScripts } from "@surreal-ck/shared/workspace-template";
import { homedir } from "node:os";
import { claimResumeWindow } from "./resume-window";

// 独立 memory 实例；业务调用者为 RECORD 会话，root 只准备夹具与模拟控制面变更。
test("LCA07 fork：恢复 owner/workspace/disabled 边界、并发 fence 与重启窗口", async () => {
  const port = 19000 + Math.floor(Math.random() * 10000);
  const password = crypto.randomUUID();
  const process = Bun.spawn([process.env.SURREAL_BINARY ?? `${homedir()}/.surrealdb/surreal`, "start", "--allow-all", "--bind", `127.0.0.1:${port}`, "--user", "test", "--pass", password, "memory"], { stdout: "ignore", stderr: "ignore" });
  const root = new Surreal();
  const callers: Surreal[] = [];
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await Bun.sleep(50); }
    const url = `ws://127.0.0.1:${port}/rpc`;
    await root.connect(url); await root.signin({ username: "test", password });
    for (const db of ["ws_a", "ws_b"]) {
      await root.query(`DEFINE NAMESPACE IF NOT EXISTS test; USE NS test; DEFINE DATABASE ${db}; USE DB ${db};
        DEFINE TABLE user SCHEMALESS PERMISSIONS FULL;
        CREATE user:a SET subject="human", disabled_at=NONE;
        CREATE user:b SET subject="other", disabled_at=NONE;
        DEFINE FUNCTION fn::current_user() { RETURN $auth.id; } PERMISSIONS FULL;
        DEFINE ACCESS caller ON DATABASE TYPE RECORD SIGNIN { RETURN IF $name = "human" { user:a } ELSE { user:b }; };
      `);
      await root.use({ namespace: "test", database: db });
      for (const script of (await loadTemplateScripts()).filter(s => [4, 5, 40].includes(s.version))) await root.query(script.sql);
    }
    await root.use({ namespace: "test", database: "ws_a" });
    await root.query(`CREATE workflow_run:r SET owner_user=user:a, run_id="research", workflow_name="routerWorkflow", kind="router", state={}, status="suspended";`);
    async function caller(db: string, name="human") { const session=new Surreal(); callers.push(session); await session.connect(url, { namespace:"test", database: db });
      await session.signin({ namespace:"test", database:db, access:"caller", variables:{ name } }); return session; }
    const a = await caller("ws_a");
    await expect(claimResumeWindow(await caller("ws_a", "other"), "research")).rejects.toMatchObject({ code: "chat-resume-unavailable" });
    await expect(claimResumeWindow(await caller("ws_b"), "research")).rejects.toMatchObject({ code: "chat-resume-unavailable" });
    const results = await Promise.allSettled([claimResumeWindow(a, "research"), claimResumeWindow(await caller("ws_a"), "research")]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const winner = results.find(r => r.status === "fulfilled");
    if (winner?.status !== "fulfilled") throw new Error("no winner");
    const oldRelease = winner.value;
    // 进程失联后等待期限：新进程可以抢占，旧 fence 无权释放新窗口。
    await root.query("UPDATE workflow_run:r SET resume_until=time::now()-1s;");
    const release = await claimResumeWindow(await caller("ws_a"), "research");
    await oldRelease();
    await expect(claimResumeWindow(a, "research")).rejects.toMatchObject({ code: "chat-resume-unavailable" });
    await release();
    await root.query("UPDATE user:a SET disabled_at=time::now();");
    await expect(claimResumeWindow(a, "research")).rejects.toMatchObject({ code: "chat-resume-unavailable" });
  } finally { await Promise.all(callers.map(c=>c.close().catch(()=>{}))); await root.close().catch(()=>{}); process.kill(); await process.exited; }
}, 60000);
