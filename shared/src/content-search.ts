/** The database enforces row and field permissions before query results leave it. */
const WHERE = `
  ($keyword = "" OR version.title CONTAINS $keyword OR version.body_text CONTAINS $keyword)
  AND ($kind = "all" OR kind = $kind)
  AND ($from = "" OR published_on >= $from)
  AND ($until = "" OR published_on <= $until)
  AND ($jurisdiction = "" OR jurisdiction = $jurisdiction)
  AND ($effective = "" OR effective_on = $effective)
`;

export const CONTENT_SEARCH_QUERY = `SELECT id, version.id AS version_id, version.public_id AS public_id,
  version.title AS title, version.revision AS revision, version.version_label AS version_label,
  kind, version.source_url AS source_url, published_on,
  jurisdiction, effective_on
  FROM content_search_facet WHERE ${WHERE}
  AND ($cursor = NONE OR id > $cursor) ORDER BY id ASC LIMIT 21;`;

export const CONTENT_SEARCH_COUNT_QUERY = `SELECT count() AS total FROM content_search_facet
  WHERE ${WHERE} GROUP ALL;`;
