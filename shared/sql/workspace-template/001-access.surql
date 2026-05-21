DEFINE ACCESS admin ON DATABASE TYPE JWT URL '<__OIDC_JWKS_URL__>'
  AUTHENTICATE {
    IF $token["https://surrealdb.com/db"] != $session.db
       OR $token["https://surrealdb.com/ac"] != "admin" {
      THROW "token not scoped to this workspace as admin";
    };

    LET $u = INSERT INTO user {
      subject: $token.sub,
      email: $token.email,
      display_name: $token.name OR $token.email OR $token.sub,
      kind: "human",
      is_admin: true,
      last_seen_at: time::now()
    } ON DUPLICATE KEY UPDATE
      is_admin = true,
      last_seen_at = time::now()
    RETURN AFTER;

    RETURN $u[0];
  };

DEFINE ACCESS participant ON DATABASE TYPE RECORD
  WITH JWT URL '<__OIDC_JWKS_URL__>'
  AUTHENTICATE {
    IF $token["https://surrealdb.com/db"] != $session.db
       OR $token["https://surrealdb.com/ac"] != "participant" {
      THROW "token not scoped to this workspace as participant";
    };

    LET $u = INSERT INTO user {
      subject: $token.sub,
      email: $token.email,
      display_name: $token.name OR $token.email OR $token.sub,
      kind: "human",
      is_admin: false,
      last_seen_at: time::now()
    } ON DUPLICATE KEY UPDATE
      is_admin = false,
      last_seen_at = time::now()
    RETURN AFTER;

    RETURN $u[0];
  }
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
