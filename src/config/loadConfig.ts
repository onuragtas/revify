import { existsSync, readFileSync } from 'node:fs';
import { config as loadDotenv } from 'dotenv';
import { load as parseYaml } from 'js-yaml';
import { z, ZodError } from 'zod';
import { homedir } from 'node:os';
import { join } from 'node:path';

loadDotenv();

// Settings written from the UI take precedence over .env — someone who
// used the settings screen expects what they typed to be in force. Applied
// before the env schema is read, and tolerant of a missing/corrupt file so
// a bad settings file can never make the app unstartable.
let overrides: Record<string, unknown> = {};
try {
  const { SettingsStore, applySettingsToEnv, configOverrides } = await import('../core/settingsStore.js');
  const store = new SettingsStore();
  applySettingsToEnv(store);
  overrides = configOverrides(store);
} catch (err) {
  console.warn('[settings] could not apply local settings:', err instanceof Error ? err.message : err);
}

/** Applies dotted overrides onto the parsed YAML, in place. config.yaml
 * keeps the defaults and the wiring; this is what a person or a team
 * changed since. */
function applyOverrides(target: Record<string, any>): void {
  for (const [path, value] of Object.entries(overrides)) {
    const keys = path.split('.');
    let node = target;
    for (const key of keys.slice(0, -1)) {
      if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
      node = node[key];
    }
    node[keys[keys.length - 1]] = value;
  }
}

// `ANTHROPIC_API_KEY=` (present but empty) in .env sets process.env to ''
// rather than leaving it unset. The Anthropic SDK's own credential
// resolution (used when we construct `new Anthropic()` with no explicit
// key) checks process.env directly and treats an empty string as "a key
// was provided", skipping its fallback to an `ant auth login` profile.
// Deleting it here restores the intended fallback behavior.
if (process.env.ANTHROPIC_API_KEY === '') {
  delete process.env.ANTHROPIC_API_KEY;
}

const wiringSchema = z.object({
  trigger: z.string(),
  contextCollectors: z.array(z.string()),
  task: z.string(),
  llm: z.string(),
  approval: z.string(),
  action: z.string(),
});

const yamlConfigSchema = z.object({
  pollIntervalMs: z.number().int().positive(),
  approvalPollIntervalMs: z.number().int().positive(),
  stateFilePath: z.string(),
  reviewsFilePath: z.string().default('./data/reviews.json'),
  jira: z.object({
    jql: z.string(),
    /** Off by default: Jira changes are visible to the whole team and
     * awkward to undo, so live writes are an explicit opt-in. */
    applyChanges: z.boolean().default(false),
    approveStatus: z.string().default('Ready for Stage'),
    rejectStatus: z.string().default('In Development'),
  }),
  review: z
    .object({
      language: z.string().default('English'),
      /** Clone the branch locally so the model can read the surrounding
       * code instead of judging from the diff alone. */
      useRepoCheckout: z.boolean().default(true),
      /** Kept outside the project by default. Clones inside it are real
       * git repositories, so an editor opening this project treats every
       * one of them as a nested checkout — and 3.5 GB of other teams' code
       * ends up in this project's search, indexing and source control. `~`
       * is expanded so the default works without knowing the home path. */
      repoCacheDir: z.string().default('~/.revify/repos'),
      notesFilePath: z.string().default('./data/reviewNotes.json'),
    })
    .default({
      language: 'English',
      useRepoCheckout: true,
      repoCacheDir: '~/.revify/repos',
      notesFilePath: './data/reviewNotes.json',
    }),
  /** Reviewing new arrivals before anyone asks. Only ever *prepares* a
   * review — approving and rejecting stay manual. */
  autoPrepare: z
    .object({
      enabled: z.boolean().default(false),
      pollIntervalMs: z.number().int().positive().default(120000),
    })
    .default({ enabled: false, pollIntervalMs: 120000 }),
  wiring: wiringSchema,
});

/**
 * Credentials are optional *to start with*.
 *
 * They used to be required, which made the app unopenable on a fresh
 * machine — and the settings screen that exists to enter them lives inside
 * the app. You cannot ask someone to configure a thing through a window
 * that will not open until it is configured. So the app starts unconfigured
 * and says so; `setup.missing` is what the UI shows.
 *
 * Format is still checked when a value *is* present: a malformed URL is a
 * mistake worth catching early, an absent one is just a fresh install.
 */
const envSchema = z.object({
  JIRA_BASE_URL: z.string().url().optional().or(z.literal('')),
  JIRA_EMAIL: z.string().email().optional().or(z.literal('')),
  JIRA_API_TOKEN: z.string().optional(),
  GITLAB_BASE_URL: z.string().url().optional().or(z.literal('')),
  GITLAB_TOKEN: z.string().optional(),
  // Only required if config.yaml's wiring.approval is set to "slackReaction".
  SLACK_BOT_TOKEN: z.string().min(1).optional(),
  SLACK_CHANNEL: z.string().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-opus-5'),
});

export type Wiring = z.infer<typeof wiringSchema>;

export interface AppConfig {
  pollIntervalMs: number;
  approvalPollIntervalMs: number;
  stateFilePath: string;
  reviewsFilePath: string;
  review: {
    language: string;
    useRepoCheckout: boolean;
    repoCacheDir: string;
    notesFilePath: string;
  };
  autoPrepare: { enabled: boolean; pollIntervalMs: number };
  /** Whether this install has everything it needs to talk to Jira and
   * GitLab. False is a first-run state, not a failure. */
  setup: { configured: boolean; missing: string[] };
  wiring: Wiring;
  jira: {
    baseUrl: string;
    email: string;
    apiToken: string;
    jql: string;
    applyChanges: boolean;
    approveStatus: string;
    rejectStatus: string;
  };
  gitlab: { baseUrl: string; token: string };
  slack: { token?: string; channel?: string };
  anthropic: { apiKey?: string; model: string };
}

/** Config file absent — a setup step, not a crash. */
export class MissingConfigError extends Error {
  constructor(readonly configPath: string) {
    super(`Config file not found: ${configPath}`);
    this.name = 'MissingConfigError';
  }
}

/** `~/x` -> `/home/you/x`. Shells expand this, config files do not. */
function expandHome(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

export function loadConfig(configPath = 'config/config.yaml'): AppConfig {
  // Not in the repo on purpose — it holds your JQL and the switches that
  // decide whether this writes to Jira, so it is yours to create.
  if (!existsSync(configPath)) {
    throw new MissingConfigError(configPath);
  }
  const rawYaml = parseYaml(readFileSync(configPath, 'utf-8')) as Record<string, any>;
  applyOverrides(rawYaml);
  const yamlConfig = yamlConfigSchema.parse(rawYaml);
  const env = envSchema.parse(process.env);

  const required: Array<[keyof typeof env, string]> = [
    ['JIRA_BASE_URL', 'Jira adresi'],
    ['JIRA_EMAIL', 'Jira e-postası'],
    ['JIRA_API_TOKEN', 'Jira API token'],
    ['GITLAB_BASE_URL', 'GitLab adresi'],
    ['GITLAB_TOKEN', 'GitLab token'],
  ];
  const missing = required.filter(([key]) => !env[key]).map(([, label]) => label);

  return {
    setup: { configured: missing.length === 0, missing },
    pollIntervalMs: yamlConfig.pollIntervalMs,
    approvalPollIntervalMs: yamlConfig.approvalPollIntervalMs,
    stateFilePath: yamlConfig.stateFilePath,
    reviewsFilePath: yamlConfig.reviewsFilePath,
    review: { ...yamlConfig.review, repoCacheDir: expandHome(yamlConfig.review.repoCacheDir) },
    autoPrepare: yamlConfig.autoPrepare,
    wiring: yamlConfig.wiring,
    jira: {
      baseUrl: env.JIRA_BASE_URL ?? '',
      email: env.JIRA_EMAIL ?? '',
      apiToken: env.JIRA_API_TOKEN ?? '',
      jql: yamlConfig.jira.jql,
      applyChanges: yamlConfig.jira.applyChanges,
      approveStatus: yamlConfig.jira.approveStatus,
      rejectStatus: yamlConfig.jira.rejectStatus,
    },
    gitlab: { baseUrl: env.GITLAB_BASE_URL ?? '', token: env.GITLAB_TOKEN ?? '' },
    slack: { token: env.SLACK_BOT_TOKEN, channel: env.SLACK_CHANNEL },
    anthropic: { apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL },
  };
}

/** Same as loadConfig(), but prints a readable error and exits instead of
 * throwing a raw ZodError — used by every entrypoint (index.ts, web/index.ts). */
export function loadConfigOrExit(configPath?: string): AppConfig {
  try {
    return loadConfig(configPath);
  } catch (err) {
    if (err instanceof MissingConfigError) {
      console.error(`Config file not found: ${err.configPath}`);
      console.error('\nRun:  cp config/config.example.yaml config/config.yaml');
      console.error('then edit its `jira.jql` to match your project.');
      process.exit(1);
    }
    if (err instanceof ZodError) {
      console.error('Config/environment validation failed. Missing or invalid fields:');
      for (const issue of err.issues) {
        console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
      }
      console.error('\nCredentials are entered in the app: open it and use Settings (⚙).');
      console.error('Config lives in config/config.yaml (copy config.example.yaml).');
      process.exit(1);
    }
    throw err;
  }
}
