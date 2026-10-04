process.env.NODE_ENV ??= "test";
process.env.HOST ??= "127.0.0.1";
process.env.PORT ??= "18080";
process.env.SURREAL_URL ??= "ws://127.0.0.1:65535/rpc";
process.env.SURREAL_NS ??= "main";
process.env.SURREAL_ROOT_USER ??= "root";
process.env.SURREAL_ROOT_PASS ??= "test-root-pass";
process.env.OIDC_ISSUER ??= "http://127.0.0.1:18081/issuer";
process.env.OIDC_JWKS_URL ??= "http://127.0.0.1:18081/jwks";
process.env.OIDC_AUDIENCE ??= "surreal-ck-test";
process.env.IDP_HOOK_SECRET ??= "test-hook-secret";
// 门户测试默认有 pepper；故意不设 CLAIMS_ATTACHMENT_*，以便测 fail-closed。
process.env.CLAIMS_PORTAL_TOKEN_PEPPER ??= "test-claims-portal-pepper-32bytes-min!!";
