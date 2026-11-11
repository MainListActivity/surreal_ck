// 独立本地 fork 行为测试。仅 fixture SIGNIN，不证明生产 JWKS / token exchange 可用。
import { strict as assert } from 'node:assert';
import { Surreal } from 'surrealdb';
import { loadTemplateScripts } from '@surreal-ck/shared/workspace-template';
const fullTemplate = process.env.SURREAL_FULL_TEMPLATE === '1';
import { randomBytes, createHash } from 'node:crypto';
const binary = process.env.SURREAL_TEST_BINARY;
if (!binary) throw new Error('SURREAL_TEST_BINARY required');
const port = 19000 + Math.floor(Math.random() * 10000);
const child = Bun.spawn([binary, 'start', '--bind', `127.0.0.1:${port}`, '--user', 'fixture', '--pass', 'local-only', 'memory'], { stdout: 'ignore', stderr: 'ignore' });
const root = new Surreal();
const clients: Surreal[] = [];
const hex = () => randomBytes(32).toString('hex');
const offer = JSON.stringify({ type: 'offer', sdp: 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 00:11\r\na=ice-ufrag:fixture\r\na=ice-pwd:fixture-only\r\n' });
const hash = createHash('sha256').update(offer).digest('hex');
type SignalRow = { status: string; offer_hash: string; [key: string]: unknown };
let checks = 0;
async function rows(c: Surreal, sql: string, vars = {}): Promise<SignalRow[]> { return (await c.query(sql, vars))[0] as SignalRow[]; }
async function denied(c: Surreal, sql: string, vars = {}) {
  let rejected = false;
  try { rejected = (await rows(c, sql, vars)).length === 0; } catch { rejected = true; }
  assert(rejected, `unexpected allowance: ${sql}`); checks++;
}
const payload = (sender = 'a', recipient = 'b') => ({ id: hex(), sender, recipient, nonce: hex(), generation: hex(), offer, hash });
const create = `CREATE type::record('native_signal', $id) SET workspace='ws_signal', sender=type::record('user',$sender), recipient=type::record('user',$recipient), nonce=$nonce, generation=$generation, offer=$offer, offer_hash=$hash,status='pending';`;
try {
  await Bun.sleep(750);
  await root.connect(`http://127.0.0.1:${port}/rpc`);
  await root.signin({ username: 'fixture', password: 'local-only' });
  await root.query('DEFINE NAMESPACE local; USE NS local; DEFINE DATABASE ws_signal; DEFINE DATABASE ws_other;');
  for (const db of ['ws_signal', 'ws_other']) {
    await root.use({ namespace: 'local', database: db });
    if (fullTemplate) {
      const scripts = await loadTemplateScripts({ oidcJwksUrl: 'http://127.0.0.1:18737/jwks' });
      assert.equal(scripts.at(-1)?.version, 62);
      for (const script of scripts) await root.query(script.sql);
      for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) {
        await root.query("CREATE type::record('user',$name) SET kind='human', email=$email, subject=$subject, is_admin=false;", { name, email: `${name}@invalid.local`, subject: `fixture-${name}` });
      }
      await root.query("DEFINE ACCESS local_test ON DATABASE TYPE RECORD SIGNIN { RETURN type::record('user', $name); };");
    } else {
    await root.query(`DEFINE TABLE user SCHEMAFULL PERMISSIONS FOR select FULL; DEFINE FIELD kind ON user TYPE string; DEFINE FIELD email ON user TYPE string; DEFINE FIELD is_admin ON user TYPE bool; DEFINE FIELD disabled_at ON user TYPE option<datetime>; CREATE user:a,user:b,user:c,user:d,user:e,user:f SET kind='human', email='fixture@invalid.local', is_admin=false; DEFINE ACCESS local_test ON DATABASE TYPE RECORD SIGNIN { RETURN type::record('user', $name); };`);
    await root.query((await Bun.file(new URL('../../shared/sql/workspace-template/061-member-identity-guard.surql', import.meta.url)).text()).replaceAll('<__OIDC_JWKS_URL__>', 'http://127.0.0.1:18737/jwks'));
    await root.query(await Bun.file(new URL('../../shared/sql/workspace-template/062-native-signaling.surql', import.meta.url)).text());
    }
  }
  for (const [name, db] of [['a','ws_signal'],['b','ws_signal'],['c','ws_signal'],['a','ws_other'],['d','ws_signal'],['e','ws_signal'],['f','ws_signal']]) {
    const c = new Surreal(); await c.connect(`http://127.0.0.1:${port}/rpc`);
    await c.signin({ namespace: 'local', database: db, access: 'local_test', variables: { name } }); clients.push(c);
  }
  const [a,b,c,other,d,e,f] = clients;
  const first = payload();
  const result = await rows(a, create, first); assert.equal(result.length,1); checks++;
  assert.equal(result[0].offer_hash,hash); checks++;
  await denied(a, create, payload()); // 每sender十秒限频，包括不同recipient。
  await denied(c, create, payload('a')); // 不可冒名。
  await denied(c, `SELECT * FROM type::record('native_signal',$id);`,first);
  await denied(other, `SELECT * FROM type::record('native_signal',$id);`,first);
  await denied(b, `UPDATE type::record('native_signal',$id) SET status='answered',answer=$offer;`,first);
  await denied(a, `UPDATE type::record('native_signal',$id) SET status='accepted';`,first);
  await denied(b, `UPDATE type::record('native_signal',$id) SET nonce=$generation,status='accepted';`,first);
  for (const assignment of ["workspace='ws_other'", 'sender=user:c', 'recipient=user:c', "generation=string::repeat('f',64)", "offer='replacement'", "offer_hash='replacement'"]) {
    await denied(b, `UPDATE type::record('native_signal',$id) SET ${assignment},status='accepted';`, first);
  }
  const originalExpiry = result[0].expires_at;
  assert.equal(String((await rows(b, `UPDATE type::record('native_signal',$id) SET expires_at=time::now()+1d,status='accepted';`,first))[0].expires_at),String(originalExpiry)); checks++;
  await denied(b, `UPDATE type::record('native_signal',$id) SET status='answered',answer=$offer;`,first);

  assert.equal((await rows(b, `UPDATE type::record('native_signal',$id) SET status='answered',answer=$answer;`,{...first,answer:offer.replace('offer','answer')}))[0].status,'answered'); checks++;
  await denied(b, `UPDATE type::record('native_signal',$id) SET answer='replacement';`,first);
  assert.equal((await rows(a, `UPDATE type::record('native_signal',$id) SET status='ended';`,first))[0].status,'ended'); checks++;
  await denied(b, `UPDATE type::record('native_signal',$id) SET status='accepted';`,first);
  await denied(a, `DELETE type::record('native_signal',$id);`,first);
  await denied(a, `SELECT * FROM native_signal_rate;`);
  const rejected = payload('c'); await rows(c,create,rejected);
  await rows(b,`UPDATE type::record('native_signal',$id) SET status='rejected';`,rejected);
  await denied(b,`UPDATE type::record('native_signal',$id) SET status='accepted';`,rejected);
  const races = await Promise.allSettled(Array.from({length:8},()=>rows(d,create,payload('d'))));
  assert.equal(races.filter(r=>r.status==='fulfilled' && r.value.length===1).length,1); checks++;
  await denied(e,create,{...payload('e'),offer:'a'.repeat(49153),hash:createHash('sha256').update('a'.repeat(49153)).digest('hex')});
  await denied(e,create,{...payload('e'),offer:'é',hash:createHash('sha256').update('é').digest('hex')});
  await denied(e,create,{...payload('e'),hash:'incorrect'});
  await denied(e,create,payload('e','missing'));
  await denied(e,create,{...payload('e'),offer:'not-json',hash:createHash('sha256').update('not-json').digest('hex')});
  const removed = payload('e'); await rows(e,create,removed);
  await root.use({namespace:'local',database:'ws_signal'});
  await root.query('UPDATE user:e SET disabled_at=time::now();'); // 控制面fixture撤销。
  await denied(e,`SELECT * FROM type::record('native_signal',$id);`,removed);
  await denied(b,`UPDATE type::record('native_signal',$id) SET status='accepted';`,removed);
  const expired = payload('f'); await rows(f,create,expired);
  console.log(`PASS ${checks} checks; waiting real 121s for expiry`);
  await Bun.sleep(121000);
  await denied(b,`UPDATE type::record('native_signal',$id) SET status='accepted';`,expired);
  await denied(f,`SELECT * FROM type::record('native_signal',$id);`,expired);
  await denied(f,create,{...expired,id:hex()}); // 保留记录阻断nonce/generation重放。
  const afterCooldown = payload('f'); assert.equal((await rows(f,create,afterCooldown)).length,1); checks++;
  console.log(`PASS ${checks} real-fork checks; template=${fullTemplate ? '001-062' : 'minimal+061+062'}`);
} finally {
  for (const c of clients) await c.close(); await root.close(); child.kill(); await child.exited;
}
