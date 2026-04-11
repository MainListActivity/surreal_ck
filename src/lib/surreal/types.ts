import { DateTime, RecordId } from "surrealdb";

export type WorkspaceRole = 'admin' | 'editor' | 'viewer';

export interface AppUser {
  id: RecordId;
  subject: string;
  email: string;
  display_name?: string;
  created_at: DateTime;
  updated_at: DateTime;
}
export interface Workspace {
  id: RecordId;
  name: string;
  slug: string;
  owner?: RecordId<'app_user'>;
  created_at: DateTime;
}

export interface Workbook {
  id: RecordId;
  workspace?: RecordId<'workspace'>;
  name: string;
  template_key?: string;
  last_viewed_sheet?: string;
  created_at: DateTime;
  updated_at: DateTime;
}

export interface WorkspaceMember {
  id: RecordId;
  workspace: RecordId<'workspace'>;
  email: string;
  role: WorkspaceRole;
  invited_at: DateTime;
}

export interface MutationRecord {
  id: RecordId;
  workbook?: RecordId<'workbook'>;
  workspace?: RecordId<'workspace'>;
  command_id: string;
  params: Record<string, unknown>;
  client_id: string;
  actor?: string;
  created_at: DateTime;
}

export interface SnapshotRecord {
  id: RecordId;
  workbook?: RecordId<'workbook'>;
  layout: Record<string, unknown>;
  coordinator_client_id: string;
  mutation_watermark?: string;
  created_at: DateTime;
}

export interface FormDefinition {
  id: RecordId;
  workspace?: RecordId<'workspace'>;
  title: string;
  slug: string;
  target_sheet: RecordId<'sheet'>;
  fields: Array<Record<string, unknown>>;
  conditional_rules: Array<Record<string, unknown>>;
  auto_edges: Array<Record<string, unknown>>;
  created_at: DateTime;
}

export interface Sheet {
  id: RecordId;
  workbook: RecordId<'workbook'>;
  univer_id: string;
  table_name: string;
  label: string;
  position: number;
  column_defs: Array<Record<string, unknown>>;
  created_at: DateTime;
  updated_at: DateTime;
}

export interface EdgeCatalogEntry {
  id: RecordId;
  workspace: RecordId<'workspace'>;
  key: string;
  label: string;
  rel_table: string;
  from_table: string | null;
  to_table: string | null;
  edge_props: Array<Record<string, unknown>>;
  created_at: DateTime;
}

export interface ClientErrorRecord {
  id: RecordId;
  workspace?: RecordId<'workspace'>;
  workbook?: RecordId<'workbook'>;
  client_id?: string;
  error_code: string;
  message: string;
  meta?: Record<string, unknown>;
  created_at: DateTime;
}

export interface AuthTokens {
  access: string;
  refresh?: string;
}

export type AuthStatus = 'checking' | 'authorizing' | 'authenticated' | 'unauthenticated' | 'error';

export interface JwtClaims {
  aud?: string | string[];
  email?: string;
  exp?: number;
  name?: string;
  preferred_username?: string;
  sub?: string;
  [key: string]: unknown;
}

export interface UserProfile {
  sub: string;
  email?: string;
  name?: string;
  recordId: string;
}

export interface OidcConfig {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUrl: string;
  clientId: string;
  audience: string;
  scope: string;
  redirectUri: string;
}

export interface AuthPendingLogin {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  returnTo: string;
  createdAt: number;
}

export interface OidcTokenBundle {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  tokenType?: string;
  scope?: string;
  accessExpiresAt: number;
  refreshExpiresAt?: number;
  issuedAt: number;
}

export interface TokenEndpointResponse {
  access_token: string;
  expires_in?: number;
  id_token?: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
}

export interface AuthSnapshot {
  status: AuthStatus;
  isLoggedIn: boolean;
  user?: UserProfile;
  error?: string;
  updatedAt: number;
}

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'auth-failed'
  | 'error';

export interface ConnectionSnapshot {
  state: ConnectionState;
  detail?: string;
  updatedAt: number;
}

export interface EnvironmentConfig {
  surrealUrl: string;
  namespace: string;
  database: string;
  authAccess: string;
}

export interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
