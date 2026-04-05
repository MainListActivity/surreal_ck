export type WorkspaceRole = 'admin' | 'editor' | 'viewer';

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  owner: string;
  created_at: string;
}

export interface Workbook {
  id: string;
  workspace: string;
  name: string;
  template_key?: string;
  last_viewed_sheet?: string;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceMember {
  id: string;
  workspace: string;
  user?: string;
  email: string;
  role: WorkspaceRole;
  invited_at: string;
}

export interface MutationRecord {
  id: string;
  workbook: string;
  workspace: string;
  command_id: string;
  params: Record<string, unknown>;
  client_id: string;
  actor?: string;
  created_at: string;
}

export interface SnapshotRecord {
  id: string;
  workbook: string;
  workspace: string;
  data: Record<string, unknown>;
  coordinator_client_id: string;
  mutation_watermark?: string;
  created_at: string;
}

export interface FormDefinition {
  id: string;
  workspace: string;
  title: string;
  slug: string;
  target_table: string;
  fields: Array<Record<string, unknown>>;
  conditional_rules: Array<Record<string, unknown>>;
  auto_relations: Array<Record<string, unknown>>;
  created_at: string;
}

export interface ClientErrorRecord {
  id: string;
  workspace?: string;
  workbook?: string;
  client_id?: string;
  error_code: string;
  message: string;
  meta?: Record<string, unknown>;
  created_at: string;
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
