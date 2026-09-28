import { test, expect } from "bun:test";
import { Surreal } from "surrealdb";
import { SignJWT } from "jose";
import { loadPlatformContentScripts } from "@surreal-ck/shared/platform-content-schema";
import { homedir } from "node:os";

test("content reader development DB permissions", async () => {
  const port = 19000 + Math.floor(Math.random() * 10000);
  const password = crypto.randomUUID();
  const proc = Bun.spawn([`${homedir()}/.surrealdb/surreal`, "start", "--bind", `127.0.0.1:${port}`, "--user", "test", "--pass", password, "memory"], { stdout: "ignore", stderr: "ignore" });
  const root = new Surreal();
  const reader = new Surreal();
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* local startup */ }
      await Bun.sleep(50);
    }
    const url = `ws://127.0.0.1:${port}/rpc`;
    await root.connect(url);
    await root.signin({ username: "test", password });
    await root.query("DEFINE NAMESPACE test; USE NS test; DEFINE DATABASE content; USE DB content;");
    await root.use({ namespace: "test", database: "content" });
    for (const script of await loadPlatformContentScripts()) await root.query(script.sql);
    const key = crypto.randomUUID();
    await root.query(`DEFINE ACCESS content_reader ON DATABASE TYPE RECORD WITH JWT ALGORITHM HS256 KEY $key AUTHENTICATE {
      RETURN (SELECT VALUE id FROM content_authorization_projection WHERE workspace_id = $token.workspace_id AND revision = $token.entitlement_revision LIMIT 1)[0];
    } DURATION FOR TOKEN 15m, FOR SESSION 15m;`, { key });
    await root.query(`
      CREATE content_source:s SET source_key='s', label='synthetic', base_url='https://example.invalid', status='active', allowed_actions=['publish'];
      CREATE source_license_revision:l SET source=content_source:s, revision=1, license_kind='synthetic', allowed_actions=['browse','read'], effective_from=time::now()-1h, created_by_subject='fixture';
      CREATE content_item:i SET public_id='i', kind='legislation', publication_status='published';
      CREATE content_version:v SET public_id='v', item=content_item:i, revision=1, source=content_source:s, source_url='https://example.invalid', fetched_at=time::now(), title='synthetic', body_text='synthetic body', body_sha256='fixture', source_form='full_text', evidence=[], field_issues=[], processing={}, content_kind_payload={}, created_by_subject='fixture';
      CREATE content_collection_binding:b SET item=content_item:i, collections=['core'];
      CREATE content_authorization_projection:p SET workspace_id='ws_test', revision='1', revision_number=1, digest='sha256:fixture', resolver_version='test', collections=['core'], content_actions=['browse'], ai_actions=[], allowed_subjects=['human'], confirmed_at=time::now(), confirmed_until=time::now()+1m, status='active';
    `);
    const token = await new SignJWT({ ns: 'test', db: 'content', ac: 'content_reader', workspace_id: 'ws_test', entitlement_revision: '1', RL: ['Owner'] }).setSubject('human').setExpirationTime('60s').setIssuedAt().setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode(key));
    await reader.connect(url, { namespace: 'test', database: 'content' });
    await reader.authenticate(token);
    const rows = await reader.query('SELECT * FROM content_version;');
    expect(rows).toEqual([[expect.objectContaining({ title: 'synthetic' })]]);
    expect(JSON.stringify(rows)).not.toContain('synthetic body');
  } finally {
    await reader.close(); await root.close(); proc.kill(); await proc.exited;
  }
}, 20000);
