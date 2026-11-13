-- 成员身份只能由 JWT Owner / 控制面维护；RECORD 不从 is_admin 获得特权。
-- 历史迁移保持不变；已有异常身份必须在上线前审计，不能自动猜测修复。
DEFINE TABLE OVERWRITE user SCHEMAFULL CHANGEFEED 7d
  PERMISSIONS
    FOR select WHERE $auth != NONE
    FOR create WHERE $auth.disabled_at = NONE
      AND $auth.kind = "virtual" AND $auth.virtual_profile.role_key = "project-manager"
      AND $auth.virtual_profile.status = "active" AND kind = "virtual" AND is_admin = false
      AND disabled_at = NONE
      AND virtual_profile.role_key = "data-analyst" AND virtual_profile.role = office_role:data_analyst
      AND virtual_profile.supervisor = $auth AND virtual_profile.status = NONE
    FOR update WHERE $auth != NONE AND $auth.disabled_at = NONE AND (
      id = $auth OR (
        $auth.kind = "virtual" AND $auth.virtual_profile.role_key = "project-manager"
        AND $auth.virtual_profile.status = "active" AND kind = "virtual" AND is_admin = false
        AND virtual_profile.role_key = "data-analyst" AND virtual_profile.supervisor = $auth))
    FOR delete NONE;

-- 字段权限是第一层边界：RECORD 对身份字段只有创建/读取权限。
-- JWT Owner 与 root 的系统 RBAC 保留正常控制面变更能力。
DEFINE FIELD OVERWRITE email ON TABLE user TYPE string PERMISSIONS FOR select, create FULL FOR update NONE;
DEFINE FIELD OVERWRITE subject ON TABLE user TYPE option<string> PERMISSIONS FOR select, create FULL FOR update NONE;
DEFINE FIELD OVERWRITE kind ON TABLE user TYPE string ASSERT $value INSIDE ["human", "virtual"] PERMISSIONS FOR select, create FULL FOR update NONE;
DEFINE FIELD OVERWRITE is_admin ON TABLE user TYPE bool DEFAULT false PERMISSIONS FOR select, create FULL FOR update NONE;
DEFINE FIELD OVERWRITE disabled_at ON TABLE user TYPE option<datetime> PERMISSIONS FOR select, create FULL FOR update NONE;
DEFINE FIELD OVERWRITE virtual_profile.role_key ON TABLE user TYPE option<string> PERMISSIONS FOR select, create FULL FOR update NONE;
DEFINE FIELD OVERWRITE virtual_profile.role ON TABLE user TYPE option<record<office_role>> PERMISSIONS FOR select, create FULL FOR update NONE;
DEFINE FIELD OVERWRITE virtual_profile.supervisor ON TABLE user TYPE option<record<user>> PERMISSIONS FOR select, create FULL FOR update NONE;

-- 事件补充冻结自身状态；字段 PERMISSIONS 拒绝可能表现为保留原值而非抛错。
-- 045 的 PM 激活守卫继续约束他人记录；此处不授予额外的 PM 写权限。
DEFINE EVENT OVERWRITE user_identity_update_guard ON TABLE user
  WHEN $event = "UPDATE" AND $auth != NONE
  THEN {
    IF $before.subject != $after.subject OR $before.email != $after.email
      OR $before.kind != $after.kind OR $before.is_admin != $after.is_admin
      OR $before.disabled_at != $after.disabled_at
      OR $before.virtual_profile.role != $after.virtual_profile.role
      OR $before.virtual_profile.role_key != $after.virtual_profile.role_key
      OR $before.virtual_profile.supervisor != $after.virtual_profile.supervisor
      OR ($auth.id = $after.id AND $before.virtual_profile.status != $after.virtual_profile.status) {
      THROW "user: identity fields require control plane";
    };
    IF $auth.id = $after.id AND $before.disabled_at != NONE {
      THROW "user: inactive identity cannot update";
    };
  };

DEFINE ACCESS OVERWRITE admin ON DATABASE TYPE JWT URL "<__OIDC_JWKS_URL__>"
  AUTHENTICATE {
      LET $existing = (
          SELECT *
          FROM ONLY user
          WHERE subject = $token.sub
      );
      IF $existing AND ($existing.disabled_at != NONE OR $existing.kind != "human") {
          THROW "user: inactive identity";
      };
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
      -- TYPE JWT 要求 NONE；不能把首次 CREATE 的记录作为块结果返回。
      RETURN NONE;
  };

DEFINE ACCESS OVERWRITE participant ON DATABASE TYPE RECORD
  WITH JWT URL "<__OIDC_JWKS_URL__>"
  AUTHENTICATE {
      LET $existing = (
          SELECT *
          FROM ONLY user
          WHERE subject = $token.sub
      );
      IF $existing AND ($existing.disabled_at != NONE OR $existing.kind != "human") {
          THROW "user: inactive identity";
      };
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
      RETURN $existing.id;
  }
  DURATION FOR TOKEN 1h, FOR SESSION NONE;

DEFINE ACCESS OVERWRITE employee ON DATABASE TYPE RECORD
  SIGNUP NONE
  SIGNIN {
    LET $u = SELECT * FROM user
      WHERE subject = $subject
        AND kind = "virtual"
        AND disabled_at = NONE
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
  AUTHENTICATE {
    IF $auth.disabled_at != NONE OR $auth.kind != "virtual" OR $auth.virtual_profile.status != "active" {
      THROW "user: inactive employee";
    };
    RETURN $auth;
  }
  DURATION FOR SESSION 1h;
