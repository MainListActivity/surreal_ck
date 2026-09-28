DEFINE ACCESS OVERWRITE content_reader ON DATABASE TYPE RECORD
    WITH JWT URL "<__CONTENT_JWKS__>"
    AUTHENTICATE {
      IF ($token.aud != "<__CONTENT_AUDIENCE__>" AND !(type::is_array($token.aud) AND "<__CONTENT_AUDIENCE__>" IN $token.aud)) OR $token.iss != "<__CONTENT_ISSUER__>"
        OR $token.exp <= time::unix(time::now()) OR $token.exp > time::unix(time::now()) + 900 {
        THROW "content identity rejected";
      };
      LET $p = (SELECT * FROM content_authorization_projection
        WHERE workspace_id = $token.workspace_id AND revision = $token.entitlement_revision LIMIT 1)[0];
      IF $p = NONE OR $p.status != "active" OR $token.sub NOT IN $p.allowed_subjects
        OR $p.confirmed_until <= time::now() OR $p.confirmed_until > $p.confirmed_at + 15m {
        THROW "content projection rejected";
      };
      RETURN $p.id;
    } DURATION FOR TOKEN 15m, FOR SESSION 15m;
