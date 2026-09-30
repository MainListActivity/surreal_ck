export {};

/** QA 手动运行：仅创建本次专用员工，最终用正常 API retire；凭证仅从环境读取。 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error("verification-config-missing");
  return value;
}
function assert(ok: boolean, code: string): asserts ok {
  if (!ok) throw new Error(code);
}

async function verify(): Promise<void> {
  const base = new URL(process.env.SCK_VERIFY_URL ?? "https://l.maplayer.top");
  assert(base.protocol === "https:" || base.hostname === "localhost" || base.hostname === "127.0.0.1", "verification-url-invalid");
  const slug = requireEnv("SCK_VERIFY_WORKSPACE");
  assert(/^[a-zA-Z0-9_-]+$/.test(slug), "verification-workspace-invalid");
  const admin = requireEnv("SCK_VERIFY_ADMIN_TOKEN");
  const participant = requireEnv("SCK_VERIFY_PARTICIPANT_TOKEN");
  const foreign = requireEnv("SCK_VERIFY_FOREIGN_ADMIN_TOKEN");
  const employeePath = `/api/workspaces/${slug}/employees`;
  const requestKey = `runtime-observation-${crypto.randomUUID()}`;
  let key: string | undefined;
  let instanceId: string | undefined;
  let retired = false;
  console.info(JSON.stringify({ action: "verification-start", workspace: slug, requestKey }));

  async function request(path: string, token: string | undefined, method = "GET", body?: unknown): Promise<Response> {
    const response = await fetch(new URL(path, base), {
      method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000),
    });
    return response;
  }
  async function action(name: "pause" | "resume" | "retire") {
    const response = await request(`${employeePath}/${key}/${name}`, admin, "POST");
    assert(response.ok, "verification-lifecycle-failed");
    // 不输出生命周期原始响应（displayName 等不是诊断证据）。
    console.info(JSON.stringify({ action: name, status: response.status }));
  }
  async function sample(action: string, usable: boolean) {
    const response = await request(`/api/internal/workspaces/${slug}/employees/${key}/runtime`, admin);
    assert(response.ok && response.headers.get("cache-control") === "no-store", "verification-observation-failed");
    const row: unknown = await response.json();
    assert(typeof row === "object" && row !== null, "verification-observation-invalid");
    const r = row as Record<string, unknown>;
    assert(typeof r.instanceId === "string" && /^[a-f0-9-]{36}$/.test(r.instanceId), "verification-instance-invalid");
    instanceId ??= r.instanceId;
    assert(r.instanceId === instanceId, "verification-instance-changed");
    assert(r.usable === usable && r.sessionPresent === usable && r.connectionCount === (usable ? 1 : 0), "verification-session-mismatch");
    assert(typeof r.generation === "number" && Number.isSafeInteger(r.generation), "verification-generation-invalid");
    assert(typeof r.sampledAt === "string" && Number.isFinite(Date.parse(r.sampledAt)), "verification-time-invalid");
    assert(r.probeCode === (usable ? "ok" : "absent"), "verification-probe-mismatch");
    if (!usable) assert(r.closeConfirmed === true && typeof r.lastClosedAt === "string", "verification-close-unconfirmed");
    // 白名单输出，响应多出的字段也不能被打印。
    console.info(JSON.stringify({ action, workspace: slug, employee: key, instanceId: r.instanceId,
      sampledAt: r.sampledAt, generation: r.generation, sessionPresent: r.sessionPresent,
      usable: r.usable, connectionCount: r.connectionCount, closeConfirmed: r.closeConfirmed,
      lastRegisteredAt: typeof r.lastRegisteredAt === "string" && Number.isFinite(Date.parse(r.lastRegisteredAt)) ? r.lastRegisteredAt : null,
      lastClosedAt: typeof r.lastClosedAt === "string" && Number.isFinite(Date.parse(r.lastClosedAt)) ? r.lastClosedAt : null,
      probeCode: r.probeCode }));
    return r.generation;
  }

  try {
    const created = await request(employeePath, admin, "POST", { requestKey, displayName: "QA runtime observation" });
    assert(created.ok, "verification-create-failed");
    const body: unknown = await created.json();
    assert(typeof body === "object" && body !== null && "employee" in body, "verification-create-invalid");
    const employee = body.employee;
    assert(typeof employee === "object" && employee !== null && "id" in employee && typeof employee.id === "string", "verification-employee-invalid");
    assert(/^user:ve_[a-f0-9]{24}$/.test(employee.id), "verification-employee-invalid");
    key = employee.id.slice(5);
    const generation = await sample("created", true);
    const diag = `/api/internal/workspaces/${slug}/employees/${key}/runtime`;
    for (const [name, token, status] of [["missing", undefined, 401], ["participant", participant, 403], ["foreign", foreign, 403]] as const) {
      const denied = await request(diag, token);
      assert(denied.status === status, "verification-authz-failed");
      console.info(JSON.stringify({ action: name, status: denied.status }));
    }
    await Promise.all([action("pause"), action("pause")]);
    await sample("paused-concurrent", false);
    await action("resume");
    assert(await sample("resumed", true) > generation, "verification-generation-not-increased");
    const replay = await Promise.all([request(employeePath, admin, "POST", { requestKey }), request(employeePath, admin, "POST", { requestKey })]);
    assert(replay.every((r) => r.ok), "verification-create-replay-failed");
    await sample("create-replay-concurrent", true);
    await Promise.all([action("retire"), action("retire")]);
    retired = true;
    await sample("retired-concurrent", false);
    const resume = await request(`${employeePath}/${key}/resume`, admin, "POST");
    assert(resume.status === 409, "verification-retired-resumed");
    await sample("retired-resume-refused", false);
  } finally {
    if (key && !retired) await action("retire");
  }
}

await verify().catch(() => {
  // 不打印 fetch/SDK 原始错误链或响应。
  console.error("employee-runtime-verification-failed (check safe stage summaries; retire dedicated employee if cleanup failed)");
  process.exitCode = 1;
});
