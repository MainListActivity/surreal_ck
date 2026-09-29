DEFINE ACCESS OVERWRITE admin ON DATABASE TYPE JWT URL "<__OIDC_JWKS_URL__>"
  AUTHENTICATE {
      LET $existing = (
          SELECT VALUE id
          FROM ONLY user
          WHERE subject = $token.sub
      );
      IF !$existing {
          CREATE user CONTENT {
              subject: $token.sub,
              email: $token.email,
              display_name: $token.email,
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
          LET $created = (CREATE ONLY user CONTENT {
              subject: $token.sub,
              email: $token.email,
              display_name: $token.email,
              kind: "human",
              is_admin: false,
              last_seen_at: time::now(),
          });
          RETURN $created.id;
      };
      RETURN $existing;
  }
  DURATION FOR TOKEN 1h, FOR SESSION NONE;

-- OVERWRITE：001 在 schema_version 落标前失败时，重试会再次执行本脚本。
-- 没有 OVERWRITE 时，已建好的 employee access 会让重试停在 provisioning_error。
DEFINE ACCESS OVERWRITE employee ON DATABASE TYPE RECORD
  SIGNUP NONE
  SIGNIN {
    LET $u = SELECT * FROM user
      WHERE subject = $subject
        AND kind = "virtual"
        AND virtual_profile.status = "active"
      LIMIT 1;

    IF array::len($u) = 0 {
      THROW "no such employee";
    };

    LET $secret = SELECT VALUE secret FROM employee_credential WHERE employee = $u[0].id LIMIT 1;
    IF array::len($secret) = 0 OR $secret[0] != $pass {
      THROW "bad secret";
    };

    RETURN $u[0];
  }
  DURATION FOR SESSION 1h;
