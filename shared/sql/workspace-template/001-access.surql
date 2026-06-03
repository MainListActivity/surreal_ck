DEFINE ACCESS OVERWRITE admin ON DATABASE TYPE JWT URL "<__OIDC_JWKS_URL__>"
  AUTHENTICATE {
      -- UPSERT 按唯一索引插入或更新
      RETURN UPSERT user CONTENT {
        subject: $token.sub,
        email: $token.email,
        display_name: $token.name ?? $token.email ?? $token.sub,
        kind: "human",
        is_admin: true,
        last_seen_at: time::now()
      } where subject=$token.sub;
    };

DEFINE ACCESS OVERWRITE participant ON DATABASE TYPE RECORD
  WITH JWT URL "<__OIDC_JWKS_URL__>"
AUTHENTICATE {
    -- UPSERT 按唯一索引插入或更新
    LET $u = UPSERT user:{$token.sub} CONTENT {
      subject: $token.sub,
      email: $token.email,
      display_name: $token.name ?? $token.email ?? $token.sub,
      kind: "human",
      is_admin: false,
      last_seen_at: time::now()
    };
    RETURN $u[0];
  };
  DURATION FOR TOKEN 1h, FOR SESSION NONE;

DEFINE ACCESS employee ON DATABASE TYPE RECORD
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
