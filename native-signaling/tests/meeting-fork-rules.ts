// 独立真实 fork/WSS 回归；夹具 RECORD 登录不替代线上 JWKS/OIDC 验收。
import { strict as assert } from "node:assert";
import { createHash, randomBytes } from "node:crypto";
import { loadTemplateScripts } from "@surreal-ck/shared/workspace-template";
import { Surreal } from "surrealdb";

const binary = process.env.SURREAL_TEST_BINARY;
assert(binary, "SURREAL_TEST_BINARY required");
const port = Number(process.env.SURREAL_TEST_PORT ?? 20000 + Math.floor(Math.random() * 20000));
const http = `http://127.0.0.1:${port}`;
const url = `ws://127.0.0.1:${port}/rpc`;
const child = Bun.spawn([binary, "start", "--bind", `127.0.0.1:${port}`, "--user", "fixture", "--pass", "local-only", "memory"],
  { stdout: "ignore", stderr: "inherit" });
const root = new Surreal();
const clients: Surreal[] = [root];
const hex = () => randomBytes(32).toString("hex");
const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");
const sdp = (type: "offer" | "answer") => JSON.stringify({ type,
  sdp: "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 00:11\r\na=ice-ufrag:fixture\r\na=ice-pwd:fixture-only\r\n" });
type Member = { member: string; join_id: string; lease_expires_unix: number };
type Snapshot = {
  workspace: string;
  room: { id: string; code: string; host: string; status: "open" | "ended"; expires_unix: number; version: number };
  local_join: string;
  members: Member[];
  server_unix: number;
};
type Signal = {
  id: string;
  workspace: string;
  room: string;
  sender: string;
  sender_join: string;
  recipient: string;
  recipient_join: string;
  attempt: number;
  nonce: string;
  route: "direct" | "relay";
  offer: string;
  offer_hash: string;
  answer?: string;
  answer_hash?: string;
  expires_unix: number;
  server_unix: number;
};

async function rpc<T = unknown>(client: Surreal, op: string, ...args: unknown[]): Promise<T> {
  const entries = args.map((value, index) => [`arg${index}`, value] as const);
  try {
    return (await client.query<[T]>(
      `RETURN fn::meeting_${op}(${entries.map(([key]) => `$${key}`).join(", ")});`,
      Object.fromEntries(entries),
    ))[0];
  } catch (cause) {
    throw new Error(`${op}: ${cause instanceof Error ? cause.message : "query failed"}`, { cause });
  }
}

async function denied(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof Error && error.message.includes(`meeting:${code}`));
}

async function use(client: Surreal, database: string) {
  await client.use({ namespace: "local", database });
}

async function member(name: string, database = "main", access = "participant") {
  const client = new Surreal();
  clients.push(client);
  await client.connect(url);
  await client.signin({ namespace: "local", database, access, variables: { name } });
  return client;
}

try {
  for (let attempt = 0; ; attempt++) {
    if (await fetch(`${http}/health`).then((response) => response.ok).catch(() => false)) break;
    assert(attempt < 80 && child.exitCode === null, "fixture fork did not start");
    await Bun.sleep(100);
  }
  await root.connect(url);
  await root.signin({ username: "fixture", password: "local-only" });
  await root.query("DEFINE NAMESPACE local; USE NS local; DEFINE DATABASE main; DEFINE DATABASE other; DEFINE DATABASE old;");
  const scripts = await loadTemplateScripts({ oidcJwksUrl: "http://127.0.0.1:18737/jwks" });
  assert.equal(scripts.at(-1)?.name, "069-native-meeting.surql");
  for (const database of ["main", "other", "old"]) {
    await use(root, database);
    for (const script of scripts) {
      if (database === "old" && script.version === 64) continue;
      await root.query(script.sql);
    }
    await root.query(`
      DEFINE ACCESS OVERWRITE participant ON DATABASE TYPE RECORD SIGNIN { RETURN type::record('user', $name); };
      DEFINE ACCESS fixture_other ON DATABASE TYPE RECORD SIGNIN { RETURN type::record('user', $name); };
      FOR $name IN ['a','b','c','d','e','f','x','y','z'] {
        CREATE type::record('user', $name) SET kind = 'human', is_admin = false,
          subject = 'fixture-' + $name, email = $name + '@invalid.local';
      };
    `);
  }
  const [a,b,c,d,e,f,x,y,z,other,old,wrongAccess] = await Promise.all([
    member("a"), member("b"), member("c"), member("d"), member("e"), member("f"), member("x"), member("y"), member("z"),
    member("a", "other"), member("a", "old"), member("a", "main", "fixture_other"),
  ]);
  assert.equal(await rpc(a, "capability"), "meeting_v1");
  await assert.rejects(rpc(old, "capability"));
  await denied(rpc(wrongAccess, "capability"), "denied");
  const aj = "1".repeat(64);
  const bj = "2".repeat(64);
  const cj = "3".repeat(64);
  const initial = await rpc<Snapshot>(a, "create", aj);
  const { id: room, code } = initial.room;
  assert.match(room, /^[a-f0-9]{64}$/);
  assert.match(code, /^[A-Z0-9]{8,32}$/);
  assert.equal(initial.room.host, "user:a");
  assert.equal(initial.workspace, "main");
  assert.equal(initial.local_join, aj);
  assert.equal(initial.room.expires_unix - initial.server_unix, 4 * 3600);
  assert.deepEqual(initial.members.map(({ member, join_id }) => ({ member, join_id })), [{ member: "user:a", join_id: aj }]);
  assert.equal((await rpc<Snapshot>(a, "create", aj)).room.id, room);
  await denied(rpc(a, "create", hex()), "conflict");
  await denied(rpc(b, "join", code, bj), "not_found");
  await denied(rpc(b, "join", "DOESNOTEXIST", bj), "not_found");
  await denied(rpc(other, "join", code, bj), "not_found");
  await denied(rpc(other, "snapshot", room, aj), "not_found");
  await denied(rpc(b, "snapshot", room, aj), "not_found");
  await denied(rpc(b, "invite", room, ["b"]), "not_found");
  assert.deepEqual(await rpc(a, "invite", room, ["b","c","d","e","f","b"]), {
    room, invited: ["user:b","user:c","user:d","user:e","user:f"],
  });
  assert.deepEqual(await rpc(x, "invitations"), []);
  const invited = await rpc<{ workspace: string; room: string; code: string; host: string }[]>(b, "invitations");
  assert.deepEqual(invited.map((v) => [v.workspace, v.room, v.code, v.host]), [["main", room, code, "user:a"]]);
  await denied(rpc(b, "snapshot", room, bj), "not_found");
  assert.equal((await rpc<Snapshot>(b, "join", code, bj)).local_join, bj);
  assert.equal((await rpc<Snapshot>(b, "join", code, bj)).local_join, bj);
  await denied(rpc(b, "join", code, hex()), "conflict");
  const secondRoom = await rpc<Snapshot>(x, "create", hex());
  await rpc(x, "invite", secondRoom.room.id, ["b"]);
  await denied(rpc(b, "join", secondRoom.room.code, hex()), "conflict");
  await rpc(x, "end", secondRoom.room.id, secondRoom.local_join);
  assert.equal((await rpc<Snapshot>(c, "join", code, cj)).members.length, 3);
  await denied(rpc(b, "end", room, bj), "denied");

  const candidates = [[d,hex()],[e,hex()],[f,hex()]] as const;
  const race = await Promise.allSettled(candidates.map(([client, join]) => rpc<Snapshot>(client, "join", code, join)));
  const winnerIndex = race.findIndex((v) => v.status === "fulfilled");
  assert.equal(race.filter((v) => v.status === "fulfilled").length, 1, "atomic last seat");
  for (const [index, [client, join]] of candidates.entries()) {
    if (index !== winnerIndex) await denied(rpc(client, "join", code, join), "full");
  }
  const [fourth, fourthJoin] = candidates[winnerIndex];
  assert.equal((await rpc<Snapshot>(a, "snapshot", room, aj)).members.length, 4);

  const offer = sdp("offer");
  const answer = sdp("answer");
  const offerHash = hash(offer);
  const answerHash = hash(answer);
  const post = (peer: string, attempt = 1, nonce = hex(), route = "direct", raw = offer, digest = hash(raw)) =>
    rpc<Signal>(a, "post_offer", room, aj, peer, attempt, nonce, route, raw, digest);
  const respond = (sender: string, initiator: string, attempt: number, nonce: string, digest = offerHash) =>
    rpc<Signal>(b, "post_answer", room, sender, initiator, attempt, nonce, digest, answer, answerHash);
  await denied(post(bj, 1, hex(), "relay"), "denied");
  await denied(post(bj, 1, hex(), "direct", offer, hex()), "denied");
  await denied(post(bj, 1, hex(), "direct", "a".repeat(49153)), "denied");
  await denied(post(bj, 1, hex(), "direct", '{"type":"offer","sdp":"\\uD800"}'), "denied");
  await denied(post(bj, 1, hex(), "direct", '{"type":"offer","sdp":'), "denied");
  await denied(post(bj, 1, hex(), "direct", JSON.stringify({ type: "offer", sdp: "非ASCII" })), "denied");
  await denied(rpc(b, "post_offer", room, bj, aj, 1, hex(), "direct", offer, offerHash), "denied");
  const firstNonce = hex();
  const first = await post(bj, 1, firstNonce);
  const second = await post(cj);
  assert.notEqual(first.id, second.id);
  assert.deepEqual([first.workspace, first.room, first.sender, first.sender_join, first.recipient, first.recipient_join,
    first.attempt, first.nonce, first.route, first.offer, first.offer_hash, first.answer],
  ["main", room, "user:a", aj, "user:b", bj, 1, firstNonce, "direct", offer, offerHash, undefined]);
  assert(first.expires_unix - first.server_unix <= 30 && first.expires_unix > first.server_unix);
  assert.deepEqual((await rpc<Signal[]>(b, "poll_offers", room, bj)).map((v) => v.id), [first.id]);
  assert.deepEqual((await rpc<Signal[]>(c, "poll_offers", room, cj)).map((v) => v.id), [second.id]);
  assert.deepEqual(await rpc(a, "poll_answers", room, aj), []);
  for (const client of [fourth, other, wrongAccess]) {
    assert.deepEqual(await client.query("SELECT * FROM native_meeting_payload;"), [[]]);
  }
  for (const table of ["native_meeting_room","native_meeting_code","native_meeting_invite","native_meeting_inbox","native_meeting_payload","native_meeting_attempt","native_meeting_presence","native_meeting_join_key","native_meeting_rate","native_meeting_command"]) {
    assert.deepEqual(await b.query(`SELECT * FROM ${table};`), [[]]);
  }
  assert.equal(await rpc(b, "room_row", room), undefined);
  await assert.rejects(b.query("RETURN fn::meeting_dispatch(user:a, 'invitations', {});"));
  await assert.rejects(rpc(b, "gc"));
  await assert.rejects(b.query(`
    CREATE type::record('native_meeting_command', [user:a, 'snapshot'])
      SET actor = user:a, op = 'snapshot', input = { room: $room, join_id: $join } RETURN NONE;
  `, { room, join: aj }), /meeting:denied/);
  assert.deepEqual(await b.query("UPDATE native_meeting_payload SET answer = 'cannot write'; DELETE native_meeting_payload;"), [[], []]);

  const replacementNonce = hex();
  const replacement = await post(bj, 2, replacementNonce, "relay");
  assert.notEqual(replacement.id, first.id);
  await denied(respond(bj, aj, 1, firstNonce), "conflict");
  await denied(respond(bj, aj, 2, replacementNonce, hex()), "conflict");
  const answered = await respond(bj, aj, 2, replacementNonce);
  assert.deepEqual([answered.id, answered.answer, answered.answer_hash, answered.route], [replacement.id, answer, answerHash, "relay"]);
  await denied(respond(bj, aj, 2, replacementNonce), "conflict");
  await denied(post(bj, 2, hex()), "conflict");
  assert.deepEqual((await rpc<Signal[]>(a, "poll_answers", room, aj)).map((v) => v.id), [replacement.id]);
  assert.deepEqual(await rpc(b, "poll_offers", room, bj), []);

  await use(root, "main");
  await root.query(`
    UPDATE type::record('native_meeting_invite', [$room, user:c]) SET revoked_at = time::now();
  `, { room });
  await denied(rpc(c, "snapshot", room, cj), "not_found");
  await denied(rpc(c, "join", code, cj), "not_found");
  await denied(rpc(c, "poll_offers", room, cj), "not_found");

  // 撤销、离开和重入即时切断旧边；旧 join ID 不能重新登记或影响新实例。
  await root.query("UPDATE user:c SET disabled_at = time::now();");
  await denied(rpc(c, "renew", room, cj), "denied");
  assert.deepEqual(await c.query("SELECT * FROM native_meeting_payload;"), [[]]);
  assert.equal((await rpc<Snapshot>(a, "snapshot", room, aj)).members.length, 3);
  await rpc(fourth, "leave", room, fourthJoin);
  await rpc(fourth, "leave", room, fourthJoin);
  await rpc(b, "leave", room, bj);
  await denied(rpc(b, "join", code, bj), "conflict");
  const bj2 = hex();
  assert.equal((await rpc<Snapshot>(b, "join", code, bj2)).local_join, bj2);
  await rpc(b, "leave", room, bj);
  await denied(rpc(b, "snapshot", room, bj), "not_found");
  assert.equal((await rpc<Snapshot>(b, "snapshot", room, bj2)).members.length, 2);
  assert.deepEqual(await rpc(a, "poll_answers", room, aj), []);
  const ended = await rpc(a, "end", room, aj);
  assert.equal(ended, undefined);
  assert.equal(await rpc(a, "end", room, aj), undefined);
  assert.equal((await rpc<Snapshot>(b, "snapshot", room, bj2)).room.status, "ended");
  await denied(rpc(b, "join", code, hex()), "expired");
  assert.deepEqual(await rpc(b, "invitations"), []);
  console.log("PASS 权限、容量竞态、续租/重入绑定、定向 SDP、替换与应答；验证真实 TTL");
  // 主持人断线、成员续租和真实 SDP 时间窗在同一轮验证。
  const xj = "0".repeat(64);
  const yj = "f".repeat(64);
  const timeout = await rpc<Snapshot>(x, "create", xj);
  const timeoutRoom = timeout.room.id;
  await rpc(x, "invite", timeoutRoom, ["y","z"]);
  await rpc(y, "join", timeout.room.code, yj);
  const expiringNonce = hex();
  const expiring = await rpc<Signal>(x, "post_offer", timeoutRoom, xj, yj, 1, expiringNonce, "direct", offer, offerHash);
  for (let i = 0; i < 12; i++) await rpc(y, "poll_offers", timeoutRoom, yj);
  await denied(rpc(y, "poll_offers", timeoutRoom, yj), "rate_limited");
  await Bun.sleep(11_000);
  const renewed = await rpc<Snapshot>(y, "renew", timeoutRoom, yj);
  assert(renewed.members.some((v) => v.join_id === yj && v.lease_expires_unix > timeout.members[0].lease_expires_unix));
  await Bun.sleep(19_500);
  assert.deepEqual(await rpc(y, "poll_offers", timeoutRoom, yj), []);
  await denied(rpc(y, "post_answer", timeoutRoom, yj, xj, 1, expiringNonce, offerHash, answer, answerHash), "expired");
  await rpc(root, "gc");
  assert.deepEqual(await root.query("SELECT id FROM native_meeting_payload WHERE wire_id = $id;", { id: expiring.id }), [[]]);
  await denied(rpc(x, "post_offer", timeoutRoom, xj, yj, 1, hex(), "direct", offer, offerHash), "conflict");
  await rpc(y, "renew", timeoutRoom, yj);
  await Bun.sleep(15_000);
  await rpc(root, "gc");
  const afterTimeout = await rpc<Snapshot>(y, "snapshot", timeoutRoom, yj);
  assert.deepEqual(afterTimeout.members.map((v) => v.member), ["user:y"]);
  assert.equal(afterTimeout.room.status, "open");
  await denied(rpc(x, "end", timeoutRoom, xj), "not_found");
  await rpc(y, "leave", timeoutRoom, yj);
  await denied(rpc(z, "join", timeout.room.code, hex()), "expired");

  // 受信任夹具推进硬过期，验证无需等待四小时且未到期的成员租约不能重新开放房间。
  const hard = await rpc<Snapshot>(x, "create", hex());
  await rpc(x, "invite", hard.room.id, ["z"]);
  await root.query("UPDATE type::record('native_meeting_room', $id) SET expires_at = time::now() - 1s;", { id: hard.room.id });
  await denied(rpc(z, "join", hard.room.code, hex()), "expired");
  await denied(rpc(x, "renew", hard.room.id, hard.local_join), "expired");
  console.log("PASS 001–069 真实 fork：SDP 清理与防重放、掉线超时、硬过期");
} finally {
  await Promise.allSettled(clients.map((client) => client.close()));
  child.kill();
  await child.exited;
}
