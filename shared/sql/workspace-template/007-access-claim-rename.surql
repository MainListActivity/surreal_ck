-- 把 admin / participant 两个 JWT access 的 email claim 从
-- `https://surrealdb.com/email` 切到短名 `email`。
-- 对已存在的 workspace database（schema_version < 7）重新 OVERWRITE。
-- 这两块必须与 001-access.surql 改后的对应块逐字一致。
-- employee access 不涉及 JWT claim，不在此重定义。

DEFINE ACCESS OVERWRITE admin ON DATABASE TYPE JWT URL "<__OIDC_JWKS_URL__>"
  AUTHENTICATE {
      LET $existing = (
          SELECT VALUE id
          FROM ONLY user
          WHERE subject = $token.sub
      );
      IF !$existing {
          LET $display_name = $token["email"];

          CREATE user CONTENT {
              subject: $token.sub,
              email: $token["email"],
              display_name: $token["email"],
              kind: "human",
              is_admin: true,
              last_seen_at: time::now(),
          };
      };
  };

DEFINE ACCESS OVERWRITE participant ON DATABASE TYPE RECORD
  WITH JWT URL "<__OIDC_JWKS_URL__>"
  AUTHENTICATE {
      LET $existing = (
          SELECT VALUE id
          FROM ONLY user
          WHERE subject = $token.sub
      );
      IF !$existing {
          LET $display_name = $token["email"];

          CREATE user CONTENT {
              subject: $token.sub,
              email: $token["email"],
              display_name: $token["email"],
              kind: "human",
              is_admin: false,
              last_seen_at: time::now(),
          };
      };
  }
  DURATION FOR TOKEN 1h, FOR SESSION NONE;
