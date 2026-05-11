import { RecordId } from "surrealdb";
import { getLocalDb } from "../db/index";
import type { AiSettingsDTO, EmbeddingSettingsDTO } from "../../shared/rpc.types";

export type SettingScope = "user" | "workspace" | "workbook";
export type AiProvider = "openai" | "anthropic" | "google" | "custom";
export type AiApiFormat = "openai-compatible" | "openai-responses" | "anthropic";

export type AppSetting<TValue extends Record<string, unknown> = Record<string, unknown>> = {
  key: string;
  scope: SettingScope;
  value: TValue;
  sensitive: boolean;
  encrypted: boolean;
  created_at?: Date;
  updated_at?: Date;
};

export type ObservabilitySettings = {
  retentionDays: number;
};

export type AiSettings = {
  provider: AiProvider;
  model: string;
  baseUrl?: string;
  apiFormat: AiApiFormat;
  apiKey?: string;
  secretConfigured: boolean;
};

export type SaveAiSettings = Omit<AiSettings, "secretConfigured"> & {
  apiKey?: string;
  clearApiKey?: boolean;
};

export type EmbeddingSettings = {
  provider: AiProvider;
  model: string;
  dimensions: number;
  version: string;
  baseUrl?: string;
  apiFormat: AiApiFormat;
  apiKey?: string;
  secretConfigured: boolean;
};

export type SaveEmbeddingSettings = Omit<EmbeddingSettings, "secretConfigured"> & {
  apiKey?: string;
  clearApiKey?: boolean;
};

export const AI_SETTINGS_KEY = "ai.provider";
export const EMBEDDING_SETTINGS_KEY = "embedding.provider";

const DEFAULT_OBSERVABILITY_RETENTION_DAYS = 30;
const DEFAULT_AI_SETTINGS: AiSettings = {
  provider: "openai",
  model: "gpt-5.4",
  apiFormat: "openai-compatible",
  secretConfigured: false,
};
const DEFAULT_EMBEDDING_SETTINGS: EmbeddingSettings = {
  provider: "openai",
  model: "text-embedding-3-small",
  dimensions: 1536,
  version: "v1",
  apiFormat: "openai-compatible",
  secretConfigured: false,
};

function settingId(key: string): RecordId {
  const normalized = key.replace(/[^a-zA-Z0-9_:-]/g, "_");
  return new RecordId("app_setting", normalized);
}

export async function getAppSetting<TValue extends Record<string, unknown>>(
  key: string
): Promise<AppSetting<TValue> | null> {
  const db = getLocalDb();
  const rows = await db.query<[AppSetting<TValue>[]]>(
    `SELECT key, scope, value, sensitive, encrypted, created_at, updated_at
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
  const db = getLocalDb();
  const rows = await db.query<[AppSetting<TValue>[]]>(
    `UPSERT $id CONTENT {
       key: $key,
       scope: $scope,
       value: $value,
       sensitive: $sensitive,
       encrypted: $encrypted,
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

export async function getAiSettings(): Promise<AiSettings> {
  const setting = await getAppSetting<{
    provider?: string;
    model?: string;
    baseUrl?: string;
    apiFormat?: string;
    apiKey?: string;
  }>(AI_SETTINGS_KEY);
  const provider = normalizeAiProvider(setting?.value?.provider);
  const model = typeof setting?.value?.model === "string" && setting.value.model.trim()
    ? setting.value.model.trim()
    : DEFAULT_AI_SETTINGS.model;
  const baseUrl = typeof setting?.value?.baseUrl === "string" && setting.value.baseUrl.trim()
    ? setting.value.baseUrl.trim()
    : undefined;
  const apiFormat = normalizeAiApiFormat(setting?.value?.apiFormat);
  const apiKey = typeof setting?.value?.apiKey === "string" ? setting.value.apiKey : undefined;

  return {
    provider,
    model,
    baseUrl,
    apiFormat,
    apiKey,
    secretConfigured: !!apiKey?.trim(),
  };
}

export async function saveAiSettings(settings: SaveAiSettings): Promise<AiSettings> {
  const existing = await getAppSetting<{
    provider?: string;
    model?: string;
    baseUrl?: string;
    apiFormat?: string;
    apiKey?: string;
  }>(AI_SETTINGS_KEY);
  const provider = normalizeAiProvider(settings.provider);
  const model = settings.model.trim();
  const baseUrl = settings.baseUrl?.trim() || undefined;
  const apiFormat = normalizeAiApiFormat(settings.apiFormat);
  const apiKey = settings.clearApiKey ? undefined : settings.apiKey ?? existing?.value?.apiKey;

  if (!model) {
    throw new Error("[settings] AI model is required");
  }

  await saveAppSetting({
    key: AI_SETTINGS_KEY,
    scope: "user",
    value: {
      provider,
      model,
      apiFormat,
      ...(baseUrl ? { baseUrl } : {}),
      ...(apiKey ? { apiKey } : {}),
    },
    sensitive: !!apiKey?.trim(),
    encrypted: false,
  });

  return {
    provider,
    model,
    baseUrl,
    apiFormat,
    apiKey,
    secretConfigured: !!apiKey?.trim(),
  };
}

export async function getEmbeddingSettings(): Promise<EmbeddingSettings> {
  const setting = await getAppSetting<{
    provider?: string;
    model?: string;
    dimensions?: number;
    version?: string;
    baseUrl?: string;
    apiFormat?: string;
    apiKey?: string;
  }>(EMBEDDING_SETTINGS_KEY);
  const provider = normalizeAiProvider(setting?.value?.provider);
  const model = typeof setting?.value?.model === "string" && setting.value.model.trim()
    ? setting.value.model.trim()
    : DEFAULT_EMBEDDING_SETTINGS.model;
  const dimensions = typeof setting?.value?.dimensions === "number" &&
    Number.isInteger(setting.value.dimensions) &&
    setting.value.dimensions > 0
    ? setting.value.dimensions
    : DEFAULT_EMBEDDING_SETTINGS.dimensions;
  const version = typeof setting?.value?.version === "string" && setting.value.version.trim()
    ? setting.value.version.trim()
    : DEFAULT_EMBEDDING_SETTINGS.version;
  const baseUrl = typeof setting?.value?.baseUrl === "string" && setting.value.baseUrl.trim()
    ? setting.value.baseUrl.trim()
    : undefined;
  const apiFormat = normalizeAiApiFormat(setting?.value?.apiFormat);
  const apiKey = typeof setting?.value?.apiKey === "string" ? setting.value.apiKey : undefined;

  return {
    provider,
    model,
    dimensions,
    version,
    baseUrl,
    apiFormat,
    apiKey,
    secretConfigured: !!apiKey?.trim(),
  };
}

export async function saveEmbeddingSettings(settings: SaveEmbeddingSettings): Promise<EmbeddingSettings> {
  const existing = await getAppSetting<{
    provider?: string;
    model?: string;
    dimensions?: number;
    version?: string;
    baseUrl?: string;
    apiFormat?: string;
    apiKey?: string;
  }>(EMBEDDING_SETTINGS_KEY);
  const provider = normalizeAiProvider(settings.provider);
  const model = settings.model.trim();
  const dimensions = Math.floor(settings.dimensions);
  const version = settings.version.trim();
  const baseUrl = settings.baseUrl?.trim() || undefined;
  const apiFormat = normalizeAiApiFormat(settings.apiFormat);
  const apiKey = settings.clearApiKey ? undefined : settings.apiKey ?? existing?.value?.apiKey;

  if (!model) {
    throw new Error("[settings] embedding model is required");
  }
  if (!Number.isFinite(dimensions) || dimensions < 1) {
    throw new Error("[settings] embedding dimensions must be a positive integer");
  }
  if (!version) {
    throw new Error("[settings] embedding profile version is required");
  }

  await saveAppSetting({
    key: EMBEDDING_SETTINGS_KEY,
    scope: "user",
    value: {
      provider,
      model,
      dimensions,
      version,
      apiFormat,
      ...(baseUrl ? { baseUrl } : {}),
      ...(apiKey ? { apiKey } : {}),
    },
    sensitive: !!apiKey?.trim(),
    encrypted: false,
  });

  return {
    provider,
    model,
    dimensions,
    version,
    baseUrl,
    apiFormat,
    apiKey,
    secretConfigured: !!apiKey?.trim(),
  };
}

export function toAiSettingsDTO(settings: AiSettings): AiSettingsDTO {
  return {
    provider: settings.provider,
    model: settings.model,
    ...(settings.baseUrl ? { baseUrl: settings.baseUrl } : {}),
    apiFormat: settings.apiFormat,
    secretConfigured: settings.secretConfigured,
  };
}

export function toEmbeddingSettingsDTO(settings: EmbeddingSettings): EmbeddingSettingsDTO {
  return {
    provider: settings.provider,
    model: settings.model,
    dimensions: settings.dimensions,
    version: settings.version,
    ...(settings.baseUrl ? { baseUrl: settings.baseUrl } : {}),
    apiFormat: settings.apiFormat,
    secretConfigured: settings.secretConfigured,
  };
}

export function observabilityExpiry(retentionDays: number): Date {
  return new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000);
}

function normalizeAiProvider(value: unknown): AiSettings["provider"] {
  if (value === "anthropic" || value === "google" || value === "custom") return value;
  return "openai";
}

function normalizeAiApiFormat(value: unknown): AiApiFormat {
  if (value === "openai-responses" || value === "anthropic") return value;
  return "openai-compatible";
}
