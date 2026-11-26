DEFINE TABLE IF NOT EXISTS meeting_v2_gateway SCHEMAFULL PERMISSIONS NONE;
DEFINE FIELD IF NOT EXISTS proof ON meeting_v2_gateway TYPE string;

DEFINE ACCESS IF NOT EXISTS meeting_v2_gateway ON DATABASE TYPE RECORD
  SIGNUP NONE
  SIGNIN {
    LET $gateway = SELECT * FROM ONLY meeting_v2_gateway:origin;
    IF $gateway = NONE OR $gateway.proof != $proof {
      THROW 'meeting:denied';
    };
    RETURN $gateway.id;
  }
  DURATION FOR TOKEN 10m, FOR SESSION 1h;

DEFINE TABLE IF NOT EXISTS meeting_v2_room SCHEMAFULL
  PERMISSIONS FOR select, create, update, delete
    WHERE session::ac() = 'meeting_v2_gateway' AND $auth.id = meeting_v2_gateway:origin;
DEFINE FIELD IF NOT EXISTS revision ON meeting_v2_room TYPE int;
DEFINE FIELD IF NOT EXISTS expires_at ON meeting_v2_room TYPE datetime;
DEFINE FIELD IF NOT EXISTS state ON meeting_v2_room TYPE object FLEXIBLE;
DEFINE INDEX IF NOT EXISTS meeting_v2_room_expiry ON meeting_v2_room FIELDS expires_at;
