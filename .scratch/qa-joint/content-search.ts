import { Surreal } from "surrealdb";
const ticket = JSON.parse(await Bun.file("/tmp/search-ticket.json").text()).body;
const s = new Surreal();
await s.connect("wss://data.maplayer.top/rpc", { namespace: ticket.namespace, database: ticket.database });
await s.authenticate(ticket.accessToken);
// 授权检索：两次查询
const q = `SELECT id, version.id AS version_id, version.public_id AS public_id,
  version.title AS title, version.revision AS revision, version.version_label AS version_label,
  kind, version.source_url AS source_url, published_on, jurisdiction, effective_on
  FROM content_search_facet WHERE ($keyword = "" OR version.title CONTAINS $keyword OR version.body_text CONTAINS $keyword)
  AND ($kind = "all" OR kind = $kind) ORDER BY id ASC LIMIT 21;`;
const r1 = await s.query(q, { keyword: "合成", kind: "all", cursor: null, from: "", until: "", jurisdiction: "", effective: "" });
console.log("SEARCH1:", JSON.stringify(r1));
const r2 = await s.query(q, { keyword: "霜层", kind: "all", cursor: null, from: "", until: "", jurisdiction: "", effective: "" });
console.log("SEARCH2:", JSON.stringify(r2));
await s.close();
