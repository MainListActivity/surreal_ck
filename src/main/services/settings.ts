import { RecordId } from "surrealdb";
import { getLocalDb } from "../db/index";

export type SettingScope = "user" | "workspace" | "workbook";

export type AppSetting<TValue extends Record<string, unknown> = Record<string, unknown>> = {
  key: string;
  scope: SettingScope;
  value: TValue;
  sensitive: boolean;
  encrypted: boolean;
  secret_ref?: string;
  created_at?: Date;
  updated_at?: Date;
};

export type ObservabilitySettings = {
  retentionDays: number;
};

const DEFAULT_OBSERVABILITY_RETENTION_DAYS = 30;

function settingId(key: string): RecordId {
  const normalized = key.replace(/[^a-zA-Z0-9_:-]/g, "_");
  return new RecordId("app_setting", normalized);
}

export async function getAppSetting<TValue extends Record<string, unknown>>(
  key: string
): Promise<AppSetting<TValue> | null> {
  const db = getLocalDb();
  const rows = await db.query<[AppSetting<TValue>[]]>(
    `SELECT key, scope, value, sensitive, encrypted, secret_ref, created_at, updated_at
     FROM app_setting
     WHERE id = $id
     LIMIT 1`,
    { id: settingId(key) }
  );

  return rows[0]?.[0] ?? null;
}

export async function saveAppSetting<TValue extends Record<string, unknown>>(
  setting: Omit<AppSetting<TValue>, "created_at" | "updated_at">
): Promise<AppSetting<TValue>> {
  if (setting.sensitive && !setting.secret_ref) {
    throw new Error("[settings] sensitive settings must use an OS secret_ref");
  }

  const db = getLocalDb();
  const rows = await db.query<[AppSetting<TValue>[]]>(
    `UPSERT $id CONTENT {
       key: $key,
       scope: $scope,
       value: $value,
       sensitive: $sensitive,
       encrypted: $encrypted,
       secret_ref: $secretRef,
       updated_at: time::now()
     }
     RETURN AFTER`,
    {
      id: settingId(setting.key),
      key: setting.key,
      scope: setting.scope,
      value: setting.value,
      sensitive: setting.sensitive,
      encrypted: setting.encrypted,
      secretRef: setting.secret_ref ?? null,
    }
  );

  return rows[0]?.[0] ?? {
    ...setting,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

export async function getObservabilitySettings(): Promise<ObservabilitySettings> {
  const setting = await getAppSetting<{ days?: number }>("observability.retention");
  const days = setting?.value?.days;

  return {
    retentionDays:
      typeof days === "number" && Number.isFinite(days) && days > 0
        ? Math.floor(days)
        : DEFAULT_OBSERVABILITY_RETENTION_DAYS,
  };
}

export async function saveObservabilitySettings(
  settings: ObservabilitySettings
): Promise<ObservabilitySettings> {
  const retentionDays = Math.floor(settings.retentionDays);
  if (!Number.isFinite(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
    throw new Error("[settings] observability retention must be between 1 and 3650 days");
  }

  await saveAppSetting({
    key: "observability.retention",
    scope: "user",
    value: { days: retentionDays },
    sensitive: false,
    encrypted: false,
  });

  return { retentionDays };
}

export function observabilityExpiry(retentionDays: number): Date {
  return new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000);
}
