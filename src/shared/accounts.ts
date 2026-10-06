// Google and Microsoft accounts that sessions can use: the shapes the daemon, the web UI and the
// sb_new_session tool share, and the scopes each provider is asked for.

export type Provider = 'google' | 'microsoft';
export const PROVIDERS: readonly Provider[] = ['google', 'microsoft'];

/** google: a gmail.com or a Workspace account; microsoft: a personal (outlook.com) or a work/school account. */
export type AccountKind = 'gmail' | 'workspace' | 'personal' | 'work';

export type AccountStatus = 'ok' | 'needs-reconsent' | 'error';

/** The operator's own OAuth app at a provider, as the UI sees it (the secret is never sent back). */
export interface AccountApp {
  provider: Provider;
  configured: boolean;
  clientId: string | null;
  /** microsoft: the tenant that owns the app registration (information only) */
  tenant: string | null;
  /** google: whether the client secret is stored */
  hasSecret: boolean;
  /** the redirect URIs to register at the provider for this hub */
  redirectUris: string[];
}

export interface Account {
  /** short, stable, used in the session's MCP server name: `google-<id>`, `ms-<id>` */
  id: string;
  provider: Provider;
  kind: AccountKind;
  email: string;
  displayName: string | null;
  /** microsoft: the account's tenant id ('consumers' for personal accounts) */
  tenant: string | null;
  scopes: string[];
  status: AccountStatus;
  lastError: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  /** tokens handed to sessions in the last 24 hours */
  mints24h: number;
  /** the MCP server name sessions see it under */
  server: string;
}

/** What a session shows about an account it has. */
export interface RunAccount {
  id: string;
  provider: Provider;
  kind: AccountKind;
  email: string;
  server: string;
  status: AccountStatus;
}

export interface AccountsSnapshot {
  /** a provider is offered only once its app is configured: without it, nothing about accounts shows */
  enabled: Record<Provider, boolean>;
  accounts: Account[];
}

/*
 * Every account always has everything it was granted (the operator's decision): mail, calendar,
 * files, contacts, tasks, and for work accounts Teams and SharePoint. Sending is included; the agent
 * decides when to use it.
 */

export const GOOGLE_SCOPES: readonly string[] = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/presentations',
  'https://www.googleapis.com/auth/contacts',
  'https://www.googleapis.com/auth/tasks',
];

/** Graph delegated scopes for every Microsoft account. All are user-consentable in Graph's terms. */
export const MS_SCOPES_PERSONAL: readonly string[] = [
  'offline_access',
  'openid',
  'profile',
  'email',
  'User.Read',
  'Mail.ReadWrite',
  'Mail.Send',
  'Calendars.ReadWrite',
  'Files.ReadWrite.All',
  'Contacts.ReadWrite',
  'Tasks.ReadWrite',
  'Notes.ReadWrite',
];

/**
 * Work and school accounts add Teams and SharePoint. Teams is not available to personal accounts in
 * Graph at all. Scopes that always need an admin (ChannelMessage.Read.All) are left out, so a user
 * who is not an admin can still sign in; a tenant whose consent policy blocks user consent needs its
 * admin to consent once (see adminConsentUrl).
 */
export const MS_SCOPES_WORK: readonly string[] = [
  ...MS_SCOPES_PERSONAL,
  'Sites.Read.All',
  'Chat.ReadWrite',
  'ChatMessage.Send',
  'ChannelMessage.Send',
  'Team.ReadBasic.All',
  'Channel.ReadBasic.All',
  'People.Read',
];

/** The tenant id Microsoft gives every personal account. */
export const MS_CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';

export function msScopes(kind: AccountKind): readonly string[] {
  return kind === 'work' ? MS_SCOPES_WORK : MS_SCOPES_PERSONAL;
}

/** The authority a Microsoft account signs in and refreshes against. */
export function msAuthority(kind: AccountKind, tenant: string | null): string {
  if (kind === 'personal') return 'consumers';
  return tenant && tenant !== MS_CONSUMER_TENANT ? tenant : 'organizations';
}

export function adminConsentUrl(tenant: string, clientId: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/adminconsent?client_id=${encodeURIComponent(clientId)}`;
}

/** The path the provider sends the browser back to, on whichever origin the hub was reached at. */
export function oauthCallbackPath(provider: Provider): string {
  return `/oauth/${provider}/callback`;
}

const PREFIX: Record<Provider, string> = { google: 'google', microsoft: 'ms' };

/** The MCP server name a session sees an account under; tools read `mcp__<server>__<tool>`. */
export function accountServer(provider: Provider, id: string): string {
  return `${PREFIX[provider]}-${id}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
}

/** An account id from an email: `david-lahuta` for david.lahuta@outlook.com, made unique by the caller. */
export function accountIdFrom(email: string): string {
  const local = email.split('@')[0] ?? 'account';
  const slug = local
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return slug || 'account';
}

export function validAccountId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(id);
}
