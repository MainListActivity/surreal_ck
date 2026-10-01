-- LCA07：只新增结构；持久化并发 fence 不携带身份凭证或内容。
DEFINE FIELD IF NOT EXISTS resume_fence ON TABLE workflow_run TYPE option<string>;
DEFINE FIELD IF NOT EXISTS resume_until ON TABLE workflow_run TYPE option<datetime>;
