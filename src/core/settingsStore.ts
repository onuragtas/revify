import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from './atomicWrite.js';

/** Settings live outside the project for the same reason the repo cache
 * does: they are yours, not the checkout's, and they must survive deleting
 * and re-cloning it. */
export const SETTINGS_DIR = join(homedir(), '.revify');
const SETTINGS_FILE = join(SETTINGS_DIR, 'settings.json');
const KEY_FILE = join(SETTINGS_DIR, 'key');

/** Field names whose values are encrypted at rest. Everything else is
 * stored in the clear so the file stays readable and diffable. */
const SECRET_FIELDS = ['jiraApiToken', 'gitlabToken', 'anthropicApiKey', 'apiSessionToken'] as const;
type SecretField = (typeof SECRET_FIELDS)[number];

export interface Settings {
  jiraBaseUrl?: string;
  jiraEmail?: string;
  jiraApiToken?: string;
  gitlabBaseUrl?: string;
  gitlabToken?: string;
  anthropicApiKey?: string;
  anthropicModel?: string;
  /* ---- operational, per machine ---- */
  /** The switch that decides whether this machine writes to real Jira
   * issues. Deliberately *not* team-wide: it is a safety catch, and a
   * safety catch someone else can release is not one. */
  applyChanges?: boolean;
  autoPrepareEnabled?: boolean;
  autoPreparePollMs?: number;
  useRepoCheckout?: boolean;
  repoCacheDir?: string;
  /** Where each GitLab project is checked out on *this* machine, keyed by
   * `group/name`. Remembered from the last time a fix patch was applied, so
   * the second patch for a repo doesn't ask again. Never guessed from the
   * repo cache: applying into the cache would look like it worked and be
   * erased by the next review. */
  fixTargets?: Record<string, string>;

  /* ---- team-wide, mirrored from the backend ---- */
  /** The last team policy this machine fetched. Cached rather than fetched
   * at startup so a slow or absent backend can never stop the app from
   * starting — it runs on what it last knew. */
  teamJql?: string;
  teamApproveStatus?: string;
  teamRejectStatus?: string;
  teamLanguage?: string;
  teamId?: string;

  /** Overrides the address that ships with the build. Empty means "use the
   * build's own" — see backendUrl(). Applied on the next request rather
   * than at startup, so changing it takes effect immediately. */
  apiUrl?: string;
  /** The session this machine holds with the team API. Kept server-side
   * rather than in a browser cookie: a cookie on localhost is readable by
   * anything else the user runs on localhost. */
  apiSessionToken?: string;
}

const ENCRYPTED_PREFIX = 'enc:v1:';

/**
 * Local settings, with credentials encrypted at rest.
 *
 * Be precise about what this protects. The key sits next to the data on the
 * same disk, so it stops **accidental disclosure** — a backup, a screen
 * share, a stray `cat`, a support bundle — not someone who can already read
 * your files as you. That is the realistic threat for a desktop tool, and
 * pretending otherwise would be worse than plaintext because it would
 * invite trusting the file somewhere it shouldn't be trusted.
 */
export class SettingsStore {
  private settings: Settings;

  constructor(private readonly filePath: string = SETTINGS_FILE) {
    this.settings = this.load();
  }

  /** Creates the key on first use. 0600 so it is not world-readable, and
   * the directory too — an unreadable key is a lost session, which is
   * recoverable; a readable one is not. */
  private key(): Buffer {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    if (existsSync(KEY_FILE)) return Buffer.from(readFileSync(KEY_FILE, 'utf-8').trim(), 'base64');

    const key = randomBytes(32);
    writeFileAtomic(KEY_FILE, key.toString('base64'));
    chmodSync(KEY_FILE, 0o600);
    return key;
  }

  private encrypt(value: string): string {
    // A fresh IV per value: reusing one under the same key in GCM destroys
    // the guarantee entirely.
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    const body = Buffer.concat([cipher.update(value, 'utf-8'), cipher.final()]);
    return ENCRYPTED_PREFIX + [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64')).join(':');
  }

  private decrypt(value: string): string {
    if (!value.startsWith(ENCRYPTED_PREFIX)) return value; // written before encryption existed
    const [ivB64, tagB64, bodyB64] = value.slice(ENCRYPTED_PREFIX.length).split(':');
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key(), Buffer.from(ivB64, 'base64'));
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(bodyB64, 'base64')), decipher.final()]).toString('utf-8');
    } catch {
      // A lost or replaced key. Returning empty means "not configured",
      // which the UI can fix; throwing would make the app unstartable.
      return '';
    }
  }

  private load(): Settings {
    if (!existsSync(this.filePath)) return {};
    let raw: Settings;
    try {
      raw = JSON.parse(readFileSync(this.filePath, 'utf-8')) as Settings;
    } catch {
      return {};
    }

    const out: Settings = { ...raw };
    for (const field of SECRET_FIELDS) {
      const value = raw[field];
      if (value) out[field] = this.decrypt(value);
    }
    return out;
  }

  private save(): void {
    const onDisk: Settings = { ...this.settings };
    for (const field of SECRET_FIELDS) {
      const value = this.settings[field];
      onDisk[field] = value ? this.encrypt(value) : undefined;
    }
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.filePath, JSON.stringify(onDisk, null, 2));
    chmodSync(this.filePath, 0o600);
  }

  all(): Settings {
    return { ...this.settings };
  }

  get<K extends keyof Settings>(key: K): Settings[K] {
    return this.settings[key];
  }

  /** Merges a patch. An empty string clears a field; `undefined` leaves it
   * alone, so a form can submit only what it means to change — otherwise
   * every save would wipe the secrets a form chose not to display. */
  update(patch: Partial<Settings>): void {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (value === '') delete this.settings[key as keyof Settings];
      else this.settings[key as keyof Settings] = value as never;
    }
    this.save();
  }

  /** What the UI may see: secrets are reported as set-or-not, never sent
   * back. A field the page cannot read is a field a page bug cannot leak. */
  redacted(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this.settings)) {
      out[key] = SECRET_FIELDS.includes(key as SecretField) ? Boolean(value) : value;
    }
    for (const field of SECRET_FIELDS) out[field] = Boolean(this.settings[field]);
    return out;
  }
}

/**
 * Turns the settings into the config overrides they represent.
 *
 * Precedence is config.yaml < this machine's settings < the team's policy.
 * The file keeps the defaults and the wiring — the part that is really code
 * — while what a person or a team decided lives where they decided it.
 */
export function configOverrides(store: SettingsStore): Record<string, unknown> {
  const s = store.all();
  const out: Record<string, unknown> = {};

  // Per machine.
  if (typeof s.applyChanges === 'boolean') out['jira.applyChanges'] = s.applyChanges;
  if (typeof s.autoPrepareEnabled === 'boolean') out['autoPrepare.enabled'] = s.autoPrepareEnabled;
  if (typeof s.autoPreparePollMs === 'number') out['autoPrepare.pollIntervalMs'] = s.autoPreparePollMs;
  if (typeof s.useRepoCheckout === 'boolean') out['review.useRepoCheckout'] = s.useRepoCheckout;
  if (s.repoCacheDir) out['review.repoCacheDir'] = s.repoCacheDir;

  // Team-wide, and therefore last: two reviewers looking at different
  // queues is not a preference, it is a disagreement nobody noticed.
  if (s.teamJql) out['jira.jql'] = s.teamJql;
  if (s.teamApproveStatus) out['jira.approveStatus'] = s.teamApproveStatus;
  if (s.teamRejectStatus) out['jira.rejectStatus'] = s.teamRejectStatus;
  if (s.teamLanguage) out['review.language'] = s.teamLanguage;

  return out;
}

/**
 * Settings win over `.env` when both are present.
 *
 * Someone who has used the settings screen expects what they typed there to
 * be in force; falling back the other way would leave them editing a form
 * that silently does nothing. `.env` stays supported for CI and for anyone
 * who prefers files.
 */
export function applySettingsToEnv(store: SettingsStore): void {
  const map: Array<[keyof Settings, string]> = [
    ['jiraBaseUrl', 'JIRA_BASE_URL'],
    ['jiraEmail', 'JIRA_EMAIL'],
    ['jiraApiToken', 'JIRA_API_TOKEN'],
    ['gitlabBaseUrl', 'GITLAB_BASE_URL'],
    ['gitlabToken', 'GITLAB_TOKEN'],
    ['anthropicApiKey', 'ANTHROPIC_API_KEY'],
    ['anthropicModel', 'ANTHROPIC_MODEL'],
  ];
  for (const [key, envVar] of map) {
    const value = store.get(key);
    if (typeof value === 'string' && value) process.env[envVar] = value;
  }
}
