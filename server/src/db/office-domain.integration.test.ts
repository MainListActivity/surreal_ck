import { afterEach, describe, expect, test } from "bun:test";
import { loadTemplateScripts } from "@surreal-ck/shared/workspace-template";
import { StringRecordId, Surreal } from "surrealdb";

/**
 * VO01 办公室领域 schema 合约测试：对真实 SurrealDB 跑 workspace template 增量 031，
 * 用 admin/participant/employee 三类真实 RECORD 会话证明权限边界。
 * 生产 admin 是 TYPE JWT + system RL=Owner（引擎层放行）；这里用 is_admin=true 的
 * RECORD 会话覆盖同一组 PERMISSIONS 表达式路径。
 */
const localSurrealTest = test.skipIf(process.env.RUN_LOCAL_SURREALDB_TESTS !== "1");
const opened: Surreal[] = [];

const url = process.env.LOCAL_SURREAL_URL ?? "ws://127.0.0.1:8000/rpc";
const namespace = process.env.LOCAL_SURREAL_NS ?? "main";
const rootUser = process.env.LOCAL_SURREAL_ROOT_USER ?? "root";
const rootPass = process.env.LOCAL_SURREAL_ROOT_PASS ?? "root";

afterEach(async () => {
  await Promise.allSettled(opened.splice(0).map((db) => db.close()));
});

async function rootConnection(database: string): Promise<Surreal> {
  const db = new Surreal();
  opened.push(db);
  await db.connect(url, {
    authentication: { username: rootUser, password: rootPass },
    namespace,
    database,
  });
  return db;
}

async function applyTemplate(root: Surreal, options: { upto?: number } = {}): Promise<void> {
  const scripts = await loadTemplateScripts({ oidcJwksUrl: "https://idp.example.test/jwks.json" });
  for (const script of scripts) {
    if (options.upto !== undefined && script.version > options.upto) break;
    await root.query(script.sql).collect();
  }
}

/** 与生产三条 access 同形的测试 access（RECORD 会话；不走 OIDC JWKS）。 */
async function defineTestAccesses(root: Surreal): Promise<void> {
  await root.query(`
    DEFINE ACCESS admin_test ON DATABASE TYPE RECORD
      SIGNIN (SELECT * FROM user WHERE subject = $subject AND kind = "human" AND is_admin = true)
      DURATION FOR SESSION 1h;
    DEFINE ACCESS participant_test ON DATABASE TYPE RECORD
      SIGNIN (SELECT * FROM user WHERE subject = $subject AND kind = "human" AND is_admin = false)
      DURATION FOR SESSION 1h;
    DEFINE ACCESS employee_test ON DATABASE TYPE RECORD
      SIGNIN (SELECT * FROM user WHERE subject = $subject AND kind = "virtual"
        AND virtual_profile.status = "active"
        AND id = (SELECT VALUE employee FROM employee_credential WHERE secret = $pass LIMIT 1)[0])
      DURATION FOR SESSION 1h;
  `).collect();
}

async function seedPrincipals(root: Surreal): Promise<void> {
  await root.query(`
    CREATE user:owner CONTENT {
      subject: "owner", email: "owner@example.test", kind: "human", is_admin: true,
      display_name: "Owner"
    };
    CREATE user:member CONTENT {
      subject: "member", email: "member@example.test", kind: "human", is_admin: false,
      display_name: "Member"
    };
    CREATE user:pm CONTENT {
      subject: "pm", email: "pm@virtual.local", kind: "virtual", is_admin: false,
      virtual_profile: { status: "active", role: office_role:project_manager, role_key: "project-manager" }
    };
    CREATE user:analyst CONTENT {
      subject: "analyst", email: "analyst@virtual.local", kind: "virtual", is_admin: false,
      virtual_profile: { status: "active", role: office_role:data_analyst, role_key: "data-analyst" }
    };
    CREATE employee_credential:pm CONTENT { employee: user:pm, secret: "pm-pass" };
    CREATE employee_credential:analyst CONTENT { employee: user:analyst, secret: "analyst-pass" };
    CREATE workbook:claims CONTENT { name: "债权台账" };
  `).collect();
}

async function signinAs(
  database: string,
  access: string,
  variables: Record<string, string>,
): Promise<Surreal> {
  const db = new Surreal();
  opened.push(db);
  await db.connect(url, { namespace, database });
  await db.signin({ namespace, database, access, variables });
  return db;
}

const admin = (db: string) => signinAs(db, "admin_test", { subject: "owner" });
const member = (db: string) => signinAs(db, "participant_test", { subject: "member" });
const pm = (db: string) => signinAs(db, "employee_test", { subject: "pm", pass: "pm-pass" });
const analyst = (db: string) => signinAs(db, "employee_test", { subject: "analyst", pass: "analyst-pass" });

function rows<T>(result: T[] | T[][]): T[] {
  const first = Array.isArray(result) ? result[0] : result;
  return Array.isArray(first) ? (first as T[]) : [];
}

describe("VO01 办公室领域 schema 合约（真实三类会话）", () => {
  localSurrealTest("新旧 workspace 幂等获得两个默认岗位，且不产生员工实例或凭证", async () => {
    const suffix = Date.now().toString(36);
    const fresh = `vo01_fresh_${suffix}`;
    const legacy = `vo01_legacy_${suffix}`;

    // 新 workspace：一次性应用全部增量
    const rootFresh = await rootConnection(fresh);
    await applyTemplate(rootFresh);
    const freshRoles = rows<{ key: string }>(
      await rootFresh.query<{ key: string }[]>("SELECT key FROM office_role ORDER BY key").collect(),
    );
    expect(freshRoles.map((r) => r.key)).toEqual(["data-analyst", "project-manager"]);
    // 模板 seed 不创建员工实例或凭证
    const virtualUsers = rows<{ id: unknown }>(
      await rootFresh.query('SELECT id FROM user WHERE kind = "virtual"').collect(),
    );
    expect(virtualUsers).toHaveLength(0);
    const credentials = rows<{ id: unknown }>(
      await rootFresh.query("SELECT id FROM employee_credential").collect(),
    );
    expect(credentials).toHaveLength(0);

    // 旧 workspace：先落到 030，再升 031；重复应用仍幂等
    const rootLegacy = await rootConnection(legacy);
    await applyTemplate(rootLegacy, { upto: 30 });
    const rolesBefore = rows<{ id: unknown }>(
      await rootLegacy.query("SELECT id FROM office_role").collect(),
    );
    expect(rolesBefore).toHaveLength(0);
    await applyTemplate(rootLegacy);
    await applyTemplate(rootLegacy); // 重放整个序列：INSERT ON DUPLICATE 不重复建行
    const legacyRoles = rows<{ key: string }>(
      await rootLegacy.query<{ key: string }[]>("SELECT key FROM office_role ORDER BY key").collect(),
    );
    expect(legacyRoles.map((r) => r.key)).toEqual(["data-analyst", "project-manager"]);
  });

  localSurrealTest("office_meta：管理员可写目标与合法 primary_contact，成员/员工只读", async () => {
    const database = `vo01_meta_${Date.now().toString(36)}`;
    const root = await rootConnection(database);
    await applyTemplate(root);
    await defineTestAccesses(root);
    await seedPrincipals(root);

    const owner = await admin(database);
    await owner.query(
      `CREATE office_meta:office CONTENT {
        goal: "把债权台账跑出风险清单",
        primary_contact: user:owner,
        state: "onboarding"
      }`,
    ).collect();

    // primary_contact 指向虚拟员工 → ASSERT 拒绝
    await expect(
      owner.query(
        `CREATE office_meta:bad CONTENT { primary_contact: user:pm }`,
      ).collect(),
    ).rejects.toThrow();

    const memberSession = await member(database);
    // 普通成员可读但不能写元数据
    const visible = rows<{ goal: string }>(
      await memberSession.query<{ goal: string }[]>("SELECT goal FROM office_meta:office").collect(),
    );
    expect(visible[0]?.goal).toBe("把债权台账跑出风险清单");
    const memberWrite = await memberSession.query(
      `UPDATE office_meta:office SET goal = "篡改目标"`,
    ).collect();
    expect(rows(memberWrite)).toHaveLength(0);

    const pmSession = await pm(database);
    const employeeWrite = await pmSession.query(
      `UPDATE office_meta:office SET primary_contact = user:pm`,
    ).collect();
    expect(rows(employeeWrite)).toHaveLength(0);
  });

  localSurrealTest("员工按权限创建任务/消息/报告/通知/DDL intent，全部由 $auth 归因", async () => {
    const database = `vo01_write_${Date.now().toString(36)}`;
    const root = await rootConnection(database);
    await applyTemplate(root);
    await defineTestAccesses(root);
    await seedPrincipals(root);

    const pmSession = await pm(database);
    const analystSession = await analyst(database);

    // PM 委派任务给 analyst：assigner 自动归因 user:pm
    const taskRows = rows<{ id: unknown; assigner: unknown; status: string; depth: number }>(
      await pmSession.query(
        `CREATE office_task CONTENT {
          goal: "核对债权人申报金额与材料",
          assignee: user:analyst
        } RETURN AFTER`,
      ).collect(),
    );
    const task = taskRows[0]!;
    expect(String(task.assigner)).toBe("user:pm");
    expect(task.status).toBe("open");
    expect(task.depth).toBe(0);

    // 子任务必须 depth = parent.depth + 1；写错深度被 ASSERT 拒绝
    await expect(
      pmSession.query(
        `CREATE office_task CONTENT {
          goal: "错误深度",
          assignee: user:analyst,
          parent: $parent,
          depth: 5
        }`,
        { parent: task.id },
      ).collect(),
    ).rejects.toThrow();
    const childRows = rows<{ depth: number }>(
      await pmSession.query(
        `CREATE office_task CONTENT {
          goal: "核对金额字段映射",
          assignee: user:analyst,
          parent: $parent,
          depth: 1
        } RETURN AFTER`,
        { parent: task.id },
      ).collect(),
    );
    expect(childRows[0]?.depth).toBe(1);

    // 指派给已停用/非 active 员工的任务被拒绝（用未建凭证的 paused 员工模拟）
    await root.query(
      `CREATE user:paused CONTENT {
        subject: "paused", email: "paused@virtual.local", kind: "virtual",
        virtual_profile: { status: "paused" }
      }`,
    ).collect();
    await expect(
      pmSession.query(
        `CREATE office_task CONTENT { goal: "派给停用员工", assignee: user:paused }`,
      ).collect(),
    ).rejects.toThrow();

    // 冒名 assigner 被拒绝
    const spoofed = await pmSession.query(
      `CREATE office_task CONTENT { goal: "冒名", assigner: user:owner, assignee: user:analyst }`,
    ).collect();
    expect(rows(spoofed)).toHaveLength(0);

    // 消息 / 报告 / 通知 / DDL intent：作者字段全部落 $auth
    const msgRows = rows<{ author: unknown; task: unknown }>(
      await analystSession.query(
        `CREATE office_message CONTENT {
          body: "开始核对，预计明早给报告。",
          task: $task,
          to: user:pm
        } RETURN AFTER`,
        { task: task.id },
      ).collect(),
    );
    expect(String(msgRows[0]?.author)).toBe("user:analyst");
    expect(String(msgRows[0]?.task)).toBe(String(task.id));

    const reportRows = rows<{ author: unknown }>(
      await analystSession.query(
        `CREATE office_report CONTENT {
          to: user:pm,
          task: $task,
          summary: "金额字段核对完成，3 条记录异常。",
          next_steps: ["对异常记录发起材料补充通知"]
        } RETURN AFTER`,
        { task: task.id },
      ).collect(),
    );
    expect(String(reportRows[0]?.author)).toBe("user:analyst");

    // 通知收件人不是员工自己 → 员工 SELECT 不到刚建的行，用 root 校验归因与字段。
    await analystSession.query(
      `CREATE user_notification CONTENT {
        dedupe_key: "office-req-1",
        to_user: user:owner,
        title: "需要确认材料口径",
        body: "申报材料是否以盖章件为准？",
        severity: "info",
        purpose: "office-request",
        payload: { question: "材料口径", options: ["盖章件", "扫描件"] },
        task: $task
      }`,
      { task: task.id },
    ).collect();
    const noteRows = rows<{ from_employee: unknown; purpose: string }>(
      await root.query<{ from_employee: unknown; purpose: string }[]>(
        "SELECT from_employee, purpose FROM user_notification WHERE dedupe_key = $k",
        { k: "office-req-1" },
      ).collect(),
    );
    expect(String(noteRows[0]?.from_employee)).toBe("user:analyst");
    expect(noteRows[0]?.purpose).toBe("office-request");

    // 冒名 from_employee 被拒：通知归因与 office_* 同构，必须等于 $auth
    const spoofedNote = await pmSession.query(
      `CREATE user_notification CONTENT {
        dedupe_key: "spoof-1", to_user: user:owner, from_employee: user:analyst,
        title: "t", body: "b", severity: "info"
      }`,
    ).collect();
    expect(rows(spoofedNote)).toHaveLength(0);

    const intentRows = rows<{ author: unknown; status: string }>(
      await analystSession.query(
        `CREATE office_ddl_intent CONTENT {
          op: "define_field",
          task: $task,
          spec: { table: "ent_claim", field: "review_note", type: "option<string>" },
          rationale: "分析产出需要沉淀审核备注字段",
          impact: "新增可选字段，不改写存量数据",
          fingerprint: "fp-add-review-note-v1"
        } RETURN AFTER`,
        { task: task.id },
      ).collect(),
    );
    expect(String(intentRows[0]?.author)).toBe("user:analyst");
    expect(intentRows[0]?.status).toBe("requested");

    // 普通成员自建任务可行（assigner = 自己），但不能替别人派单
    const memberSession = await member(database);
    const memberTask = rows<{ assigner: unknown }>(
      await memberSession.query(
        `CREATE office_task CONTENT { goal: "自查", assignee: user:member } RETURN AFTER`,
      ).collect(),
    );
    expect(String(memberTask[0]?.assigner)).toBe("user:member");
  });

  localSurrealTest("创建元数据与 payload 不可改写，状态迁移受 EVENT 守卫", async () => {
    const database = `vo01_state_${Date.now().toString(36)}`;
    const root = await rootConnection(database);
    await applyTemplate(root);
    await defineTestAccesses(root);
    await seedPrincipals(root);

    const pmSession = await pm(database);
    const analystSession = await analyst(database);
    const owner = await admin(database);

    const task = rows<{ id: unknown }>(
      await pmSession.query(
        `CREATE office_task CONTENT { goal: "状态机验证", assignee: user:analyst } RETURN AFTER`,
      ).collect(),
    )[0]!;

    // READONLY：assigner/assignee/depth 不可改
    for (const field of ["assigner = user:owner", "assignee = user:owner", "depth = 3"]) {
      await expect(pmSession.query(`UPDATE $task SET ${field}`, { task: task.id }).collect())
        .rejects.toThrow();
    }
    // 消息 append-only：UPDATE 直接被 PERMISSIONS 拒绝
    const msg = rows<{ id: unknown }>(
      await pmSession.query(
        `CREATE office_message CONTENT { body: "原消息" } RETURN AFTER`,
      ).collect(),
    )[0]!;
    const msgUpdate = await pmSession.query(`UPDATE $msg SET body = "改写"`, { msg: msg.id }).collect();
    expect(rows(msgUpdate)).toHaveLength(0);

    // 任务状态机：open → in_progress → done 合法；done → open 被守卫回滚
    await analystSession.query(`UPDATE $task SET status = "in_progress"`, { task: task.id }).collect();
    await analystSession.query(`UPDATE $task SET status = "done"`, { task: task.id }).collect();
    await expect(
      analystSession.query(`UPDATE $task SET status = "open"`, { task: task.id }).collect(),
    ).rejects.toThrow(/terminal/i);
    const stillDone = rows<{ status: string }>(
      await root.query<{ status: string }[]>(`SELECT status FROM $task`, { task: task.id }).collect(),
    );
    expect(stillDone[0]?.status).toBe("done");

    // 通知解决一次性：第二次改写 resolution 被守卫回滚
    await pmSession.query(
      `CREATE user_notification CONTENT {
        dedupe_key: "req-1", to_user: user:owner, title: "t", body: "b", severity: "info"
      }`,
    ).collect();
    const note = rows<{ id: unknown }>(
      await root.query<{ id: unknown }[]>(
        "SELECT id FROM user_notification WHERE dedupe_key = $k",
        { k: "req-1" },
      ).collect(),
    )[0]!;
    await owner.query(
      `UPDATE $note SET resolution = "已处理", resolved_at = time::now()`,
      { note: note.id },
    ).collect();
    await expect(
      owner.query(`UPDATE $note SET resolution = "改口"`, { note: note.id }).collect(),
    ).rejects.toThrow(/terminal/i);
    const resolved = rows<{ resolution: string }>(
      await root.query<{ resolution: string }[]>(`SELECT resolution FROM $note`, { note: note.id }).collect(),
    );
    expect(resolved[0]?.resolution).toBe("已处理");

    // DDL intent：仅管理员推进状态机；员工不能改；非法迁移被守卫回滚
    const intent = rows<{ id: unknown }>(
      await analystSession.query(
        `CREATE office_ddl_intent CONTENT {
          op: "define_table", task: $task, spec: { table: "ent_x" }, rationale: "r", impact: "i", fingerprint: "fp-1"
        } RETURN AFTER`,
        { task: task.id },
      ).collect(),
    )[0]!;
    const employeeUpdate = await analystSession.query(
      `UPDATE $intent SET status = "approved"`, { intent: intent.id },
    ).collect();
    expect(rows(employeeUpdate)).toHaveLength(0);

    const recordAdminUpdate = await owner.query(
      `UPDATE $intent SET status = "approved", decided_by = user:owner, decided_at = time::now()`,
      { intent: intent.id },
    ).collect();
    // VO05 要求当前 admin JWT access；is_admin=true 的 RECORD 同样不可推进。
    expect(rows(recordAdminUpdate)).toHaveLength(0);
    // 真正 admin JWT 与 DDL 状态机纵切由 analyst-ddl.integration.test.ts 覆盖。
    await expect(
      root.query(`UPDATE $intent SET status = "succeeded"`, { intent: intent.id }).collect(),
    ).rejects.toThrow(/transition/i);
  });

  localSurrealTest("结构化 answer 与 resolution 同属终态：收件人首答幂等，改口被守卫回滚", async () => {
    const database = `vo01_answer_${Date.now().toString(36)}`;
    const root = await rootConnection(database);
    await applyTemplate(root);
    await defineTestAccesses(root);
    await seedPrincipals(root);

    const pmSession = await pm(database);
    const memberSession = await member(database);

    // 员工创建指向普通成员的通知；participant 收件人是唯一有权作答的人
    await pmSession.query(
      `CREATE user_notification CONTENT {
        dedupe_key: "req-answer", to_user: user:member, title: "t", body: "b",
        severity: "info", purpose: "office-request"
      }`,
    ).collect();
    const note = rows<{ id: unknown }>(
      await root.query<{ id: unknown }[]>(
        "SELECT id FROM user_notification WHERE dedupe_key = $k",
        { k: "req-answer" },
      ).collect(),
    )[0]!;

    // 首次解决：结构化答复与文字 resolution、resolved_at 一起落库
    await memberSession.query(
      `UPDATE $note SET answer = { choice: "A" }, resolution = "选了 A", resolved_at = time::now()`,
      { note: note.id },
    ).collect();

    // 重复提交同值天然幂等（不报错、不改值）
    await memberSession.query(
      `UPDATE $note SET answer = { choice: "A" }, resolution = "选了 A"`,
      { note: note.id },
    ).collect();

    // 改口：answer 与 resolution 一样被终态守卫拒绝
    await expect(
      memberSession.query(`UPDATE $note SET answer = { choice: "B" }`, { note: note.id }).collect(),
    ).rejects.toThrow(/terminal/i);
    // 清空同样被拒绝
    await expect(
      memberSession.query(`UPDATE $note SET answer = NONE`, { note: note.id }).collect(),
    ).rejects.toThrow(/terminal/i);

    // 回滚验证：被拒写不落地，原值原样保留
    const kept = rows<{ answer: { choice: string }; resolution: string }>(
      await root.query<{ answer: { choice: string }; resolution: string }[]>(
        `SELECT answer, resolution FROM $note`,
        { note: note.id },
      ).collect(),
    );
    expect(kept[0]?.answer.choice).toBe("A");
    expect(kept[0]?.resolution).toBe("选了 A");
  });

  localSurrealTest("存量债权通知 fixture 无损迁移，收件箱/解决/去重语义不变", async () => {
    const database = `vo01_notif_${Date.now().toString(36)}`;
    const root = await rootConnection(database);
    // 旧 workspace：先到 030，用员工会话按旧字段写一条债权提醒，再升 031
    await applyTemplate(root, { upto: 30 });
    await defineTestAccesses(root);
    await seedPrincipals(root);
    const pmSession = await pm(database);
    const legacy = {
      dedupe_key: "2026-07-17|workbook:claims|ent_material:m1|missing-material",
      to_user: new StringRecordId("user:owner"),
      workbook: new StringRecordId("workbook:claims"),
      related_record: new StringRecordId("ent_material:m1"),
      risk_type: "missing-material",
      title: "材料缺失",
      body: "材料记录被标记为缺失",
      severity: "warning",
      requested_action: "查看命中数据并决定是否处理",
      matched_fields: { is_missing: true },
      rule: "是否缺失为是",
      checked_at: new Date("2026-07-17T01:00:00.000Z"),
    };
    await pmSession.query(
      "INSERT INTO user_notification $content ON DUPLICATE KEY UPDATE dedupe_key = $input.dedupe_key",
      { content: legacy },
    ).collect();

    await applyTemplate(root); // 应用 031

    // fixture 行无损：旧字段原样可读
    const rowsAfter = rows<Record<string, unknown>>(
      await root.query<Record<string, unknown>[]>("SELECT * FROM user_notification").collect(),
    );
    expect(rowsAfter).toHaveLength(1);
    expect(rowsAfter[0]?.risk_type).toBe("missing-material");
    expect(rowsAfter[0]?.title).toBe("材料缺失");
    expect(String(rowsAfter[0]?.related_record)).toBe("ent_material:m1");

    // 去重语义不变：重放 ON DUPLICATE 仍是单行
    await pmSession.query(
      "INSERT INTO user_notification $content ON DUPLICATE KEY UPDATE dedupe_key = $input.dedupe_key",
      { content: legacy },
    ).collect();
    const countAfter = rows<{ count: number }>(
      await root.query<{ count: number }[]>("SELECT count() FROM user_notification GROUP ALL").collect(),
    );
    expect(countAfter[0]?.count).toBe(1);

    // 收件箱语义：未解决可见 → owner 解决 → 列表清空且 resolution 终态
    const owner = await admin(database);
    const inbox = rows<{ id: unknown }>(
      await owner.query("SELECT id FROM user_notification WHERE resolved_at = NONE").collect(),
    );
    expect(inbox).toHaveLength(1);
    await owner.query(
      `UPDATE user_notification SET resolution = "已补齐材料", resolved_at = time::now()
       WHERE dedupe_key = $key`,
      { key: legacy.dedupe_key },
    ).collect();
    const inboxAfter = rows<{ id: unknown }>(
      await owner.query("SELECT id FROM user_notification WHERE resolved_at = NONE").collect(),
    );
    expect(inboxAfter).toHaveLength(0);
  });

  localSurrealTest("两个 workspace database 天然隔离：同名会话互不可见", async () => {
    const suffix = Date.now().toString(36);
    const dbA = `vo01_iso_a_${suffix}`;
    const dbB = `vo01_iso_b_${suffix}`;

    const rootA = await rootConnection(dbA);
    await applyTemplate(rootA);
    await defineTestAccesses(rootA);
    await seedPrincipals(rootA);

    const rootB = await rootConnection(dbB);
    await applyTemplate(rootB);
    await defineTestAccesses(rootB);
    // dbB 不 seed 业务用户里的办公室数据，只种最小身份
    await rootB.query(`
      CREATE user:member CONTENT { subject: "member", email: "m@x", kind: "human", is_admin: false };
      CREATE user:pm CONTENT { subject: "pm", email: "pm@v", kind: "virtual",
        virtual_profile: { status: "active" } };
      CREATE employee_credential:pm CONTENT { employee: user:pm, secret: "pm-pass" };
    `).collect();

    // dbA 写入办公室数据
    const pmA = await pm(dbA);
    await pmA.query(
      `CREATE office_task CONTENT { goal: "A 库任务", assignee: user:pm }`,
    ).collect();

    // dbB 同身份会话看不到 dbA 的数据；dbA 自己的岗位 seed 互不影响
    const memberB = await member(dbB);
    const tasksInB = rows<{ id: unknown }>(
      await memberB.query("SELECT id FROM office_task").collect(),
    );
    expect(tasksInB).toHaveLength(0);
    const rolesInB = rows<{ key: string }>(
      await memberB.query<{ key: string }[]>("SELECT key FROM office_role ORDER BY key").collect(),
    );
    expect(rolesInB.map((r) => r.key)).toEqual(["data-analyst", "project-manager"]);
  });
});
