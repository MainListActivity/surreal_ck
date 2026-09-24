import { describe, expect, test } from "bun:test";
import { Surreal } from "surrealdb";
import { loadPlatformContentScripts } from "@surreal-ck/shared/platform-content-schema";
import { migrateLegacyPlatformContent, assertLegacyContentMigrated } from "./migrate-legacy";
import { ensurePlatformContentSchema } from "./schema";

const localTest = test.skipIf(process.env.RUN_LOCAL_PLATFORM_CONTENT_TESTS !== "1");

describe("legacy content migration", () => {
  localTest("resumes after a partial copy and verifies IDs, body hash and publication state", async () => {
    const namespace = `content_migrate_${crypto.randomUUID().replaceAll("-", "")}`;
    const url = process.env.LOCAL_SURREAL_URL ?? "ws://127.0.0.1:8999/rpc";
    const source = new Surreal();
    const target = new Surreal();
    const authentication = { username: "root", password: "root" };
    await source.connect(url, { namespace: "main", database: "main", authentication });
    await source.query(`DEFINE NAMESPACE IF NOT EXISTS ${namespace};`);
    await source.use({ namespace });
    await source.query("DEFINE DATABASE IF NOT EXISTS _system; DEFINE DATABASE IF NOT EXISTS platform_content;");
    await source.use({ namespace, database: "_system" });
    await target.connect(url, { namespace, database: "platform_content", authentication });
    try {
      await expect(assertLegacyContentMigrated(source, target)).resolves.toBeUndefined();
      const scripts = await loadPlatformContentScripts();
      for (const script of scripts.filter((script) => script.version < 5)) await source.query(script.sql);
      await ensurePlatformContentSchema(target, { namespace, database: "platform_content" });
      await source.query(`
        CREATE content_source:fixture CONTENT {
          source_key: "fixture", label: "测试来源", base_url: "https://example.invalid",
          status: "active", allowed_actions: ["submit", "publish"]
        };
        CREATE content_item:fixture CONTENT {
          public_id: "item-stable", kind: "legislation", publication_status: "published",
          publication_revision: 1
        };
        CREATE content_version:fixture CONTENT {
          public_id: "version-stable", item: content_item:fixture, revision: 1,
          source: content_source:fixture, source_url: "https://example.invalid/law",
          fetched_at: time::now(), title: "测试法规", body_text: "第一条 测试",
          body_sha256: "fixture-hash", source_form: "full_text", evidence: [],
          field_issues: [], processing: {}, content_kind_payload: {},
          created_by_subject: "operator:fixture"
        };
        UPDATE content_item:fixture SET current_version = content_version:fixture;
        CREATE legal_article_version:fixture CONTENT {
          regulation_version: content_version:fixture, local_key: "article-1",
          label: "第一条", hierarchy_path: [], body_text: "第一条 测试"
        };
        CREATE content_citation:fixture CONTENT {
          document_version: content_version:fixture, local_citation_key: "citation-1",
          relation_kind: "explicit_citation", speaker: "court",
          quoted_text: "第一条", locator: {}, resolution: "verified", candidates: []
        };
        CREATE citation_resolution:fixture CONTENT {
          citation: content_citation:fixture, revision: 1, status: "verified",
          candidates: [], verified_by_subject: "operator:fixture"
        };
        RELATE content_citation:fixture->cites_article->legal_article_version:fixture
          CONTENT { resolution_revision: citation_resolution:fixture };
      `);
      await expect(assertLegacyContentMigrated(source, target)).rejects.toThrow();
      let injected = false;
      await expect(migrateLegacyPlatformContent({
        source,
        target: {
          query: (sql, params) => target.query(sql, params),
          select: (id) => target.select(id),
          create(id) {
            if (!injected && String(id) === "content_item:fixture") {
              injected = true;
              throw new Error("injected copy interruption");
            }
            return target.create(id);
          },
          relate: (from, edge, to, data) => target.relate(from, edge, to, data),
          upsert: (id) => target.upsert(id),
        },
        writesFrozen: true,
      })).rejects.toThrow("injected copy interruption");
      const summary = await migrateLegacyPlatformContent({ source, target, writesFrozen: true });
      expect(summary.content_source).toBe(1);
      expect(summary.content_item).toBe(1);
      expect(summary.content_version).toBe(1);
      expect(summary.cites_article).toBe(1);
      await expect(migrateLegacyPlatformContent({ source, target, writesFrozen: true })).resolves.toEqual(summary);
      await expect(assertLegacyContentMigrated(source, target)).resolves.toBeUndefined();
      const [versions] = await target.query<[{ public_id: string; body_sha256: string }[]]>(
        "SELECT public_id, body_sha256 FROM content_version:fixture;",
      );
      expect(versions[0]).toMatchObject({ public_id: "version-stable", body_sha256: "fixture-hash" });
      await target.query(`CREATE content_source:post_cutover CONTENT {
        source_key: "post-cutover", label: "新库合法新增", base_url: "https://example.invalid/new",
        status: "active", allowed_actions: ["submit"]
      };`);
      await expect(assertLegacyContentMigrated(source, target)).resolves.toBeUndefined();
      await source.query("UPDATE content_source:fixture SET label = '旧库被重新改写';");
      await expect(assertLegacyContentMigrated(source, target)).rejects.toThrow("content migration mismatch");
      await source.query("UPDATE content_source:fixture SET label = '测试来源';");
      const brokenReference = `CREATE content_source_record:broken CONTENT {
        source: content_source:missing, record_key: "broken", item: content_item:fixture,
        source_url: "https://example.invalid/broken"
      };`;
      await source.query(brokenReference);
      await target.query(brokenReference);
      await expect(assertLegacyContentMigrated(source, target)).rejects.toThrow("broken migrated reference");
      await target.query("DELETE content_source_record:broken;");
      await expect(assertLegacyContentMigrated(source, target)).rejects.toThrow("content migration count mismatch");
    } finally {
      await Promise.all([source.close(), target.close()]);
    }
  });
});
