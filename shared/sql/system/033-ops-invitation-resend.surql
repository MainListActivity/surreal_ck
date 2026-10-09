-- G2 激活链接重签发：律师断链/链接 24h 过期后的常设补救路径。
-- resend 把 IdP 新签发的 activation_url 暂存回本行（复用 032 的收取语义），
-- 并记重签发归因：resent_at（最近一次重签发时刻，兼作 24h 内重放去重依据）、
-- resent_by（操作主体）。URL 本体仍不上读路径，首收取即清除。
DEFINE FIELD IF NOT EXISTS resent_at ON ops_invitation TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS resent_by ON ops_invitation TYPE option<string>;
