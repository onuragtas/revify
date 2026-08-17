import { existsSync, readFileSync } from 'node:fs';
import { config as loadDotenv } from 'dotenv';
import { load as parseYaml } from 'js-yaml';
import { z, ZodError } from 'zod';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

loadDotenv();

// Settings written from the UI take precedence over .env — someone who
// used the settings screen expects what they typed to be in force. Applied
// before the env schema is read, and tolerant of a missing/corrupt file so
// a bad settings file can never make the app unstartable.
let overrides: Record<string, unknown> = {};

/**
 * Re-reads the settings file and re-applies what it implies.
 *
 * Called once at import, and again whenever the settings screen saves —
 * which is what lets a change take effect without restarting. Computing
 * this only at import was the reason a saved setting used to need a
 * restart: the value on disk had changed, but nothing ever looked again.
 */
export async function refreshSettingsOverrides(): Promise<void> {
  try {
    const { SettingsStore, applySettingsToEnv, configOverrides } = await import('../core/settingsStore.js');
    const store = new SettingsStore();
    applySettingsToEnv(store);
    overrides = configOverrides(store);
  } catch (err) {
    console.warn('[settings] could not apply local settings:', err instanceof Error ? err.message : err);
  }
}

await refreshSettingsOverrides();

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

/** Defaulted field by field, so a config file that sets only `task:` keeps
 * the rest of the standard pipeline instead of failing to parse. */
const wiringSchema = z.object({
  trigger: z.string().default('jiraStatusPoll'),
  contextCollectors: z
    .array(z.string())
    .default(['jiraIssueContext', 'gitlabBranchDiffContext', 'localRepoDiffContext']),
  task: z.string().default('codeReview'),
  llm: z.string().default('claudeCli'),
  approval: z.string().default('webApproval'),
  action: z.string().default('jiraReviewOutcome'),
});

const yamlConfigSchema = z.object({
  pollIntervalMs: z.number().int().positive().default(60000),
  approvalPollIntervalMs: z.number().int().positive().default(20000),
  stateFilePath: z.string().default('./data/state.json'),
  reviewsFilePath: z.string().default('./data/reviews.json'),
  jira: z.object({
    /* Empty by default rather than a placeholder: there is no sensible
     * guess at which issues are yours, and a placeholder that matches
     * nothing looks like a working queue that never fills. Empty is
     * reported as missing, and the team's policy fills it after sign-in. */
    jql: z.string().default(''),
    /** Off by default: Jira changes are visible to the whole team and
     * awkward to undo, so live writes are an explicit opt-in. */
    applyChanges: z.boolean().default(false),
    approveStatus: z.string().default('Ready for Stage'),
    rejectStatus: z.string().default('In Development'),
  }).default({}),
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
  /** How often to check what is waiting on you. Separate from the trigger
   * poll: this one also asks the team API, and it is what decides how soon
   * an assignment from a colleague reaches you. */
  reminders: z
    .object({
      enabled: z.boolean().default(true),
      pollIntervalMs: z.number().int().positive().default(900000),
    })
    .default({ enabled: true, pollIntervalMs: 900000 }),
  wiring: wiringSchema.default({}),
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
  reminders: { enabled: boolean; pollIntervalMs: number };
  /** Whether this install has everything it needs to talk to Jira and
   * GitLab. False is a first-run state, not a failure. */
  setup: { configured: boolean; missing: string[]; configMissing: boolean; queueReady: boolean };
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

/** `~/x` -> `/home/you/x`. Shells expand this, config files do not. */
function expandHome(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

/**
 * Where `./data/state.json` actually lands.
 *
 * Relative paths in the config are relative to the checkout — which is
 * right when you are running from one. An installed app has no checkout:
 * its working directory is wherever the launcher happened to be (`/` on
 * macOS), so `./data` meant a write to the root of the disk, and the app
 * that could not find a config also could not save a thing.
 *
 * So: no config file means no checkout, and the data belongs with the
 * settings, in the home directory. With a checkout, nothing changes — the
 * data that is already in ./data stays where it is.
 */
function dataPath(p: string, baseDir: string): string {
  const expanded = expandHome(p);
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

export function loadConfig(configPath = 'config/config.yaml'): AppConfig {
  /*
   * A missing config file is a first run, not a failure.
   *
   * It used to exit here — which for the desktop app meant the process died
   * before a window existed: you double-click and nothing happens, with the
   * explanation in a terminal nobody opened. The same mistake as requiring
   * credentials to start, in the one place it was not fixed.
   *
   * The example is the fallback because its defaults are the safe ones:
   * Jira writes off, auto-prepare off. Failing that, the schema's own
   * defaults. Either way the app opens and can say what is missing.
   */
  const examplePath = join(dirname(configPath), 'config.example.yaml');
  const usedPath = existsSync(configPath)
    ? configPath
    : existsSync(examplePath)
      ? examplePath
      : null;
  const configMissing = usedPath !== configPath;

  const rawYaml = (usedPath ? parseYaml(readFileSync(usedPath, 'utf-8')) : {}) as Record<string, any>;

  // The example's JQL is an illustration — `project = "PROJ"` — and it
  // matches nothing. Inherited as-is it produced the worst possible state:
  // a queue that reports itself configured and stays empty forever. The
  // example lends its defaults and its wiring, not its query.
  if (configMissing && rawYaml.jira) delete rawYaml.jira.jql;

  // After the deletion, so a team policy or an env override still wins.
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

  /*
   * A missing JQL is not a missing setup.
   *
   * It used to count as one, which made the whole app unusable without a
   * team policy. But the JQL only decides what the *queue* contains —
   * reviewing an issue by typing its key needs none of it. So the two are
   * separate questions: credentials decide whether anything can work,
   * the query decides whether a list can be filled.
   */
  const queueReady = Boolean(yamlConfig.jira.jql.trim());

  /*
   * The checkout, when there is one — and the example file is what proves
   * it: an installed app ships neither config file, a checkout has at
   * least the example. Keying off the *missing* config instead would have
   * moved the data of anyone who merely deleted their config.yaml,
   * hiding a review history that was sitting right there in ./data.
   */
  const baseDir = usedPath ? process.cwd() : join(homedir(), '.revify');

  return {
    setup: { configured: missing.length === 0, missing, configMissing, queueReady },
    pollIntervalMs: yamlConfig.pollIntervalMs,
    approvalPollIntervalMs: yamlConfig.approvalPollIntervalMs,
    stateFilePath: dataPath(yamlConfig.stateFilePath, baseDir),
    reviewsFilePath: dataPath(yamlConfig.reviewsFilePath, baseDir),
    review: {
      ...yamlConfig.review,
      repoCacheDir: expandHome(yamlConfig.review.repoCacheDir),
      notesFilePath: dataPath(yamlConfig.review.notesFilePath, baseDir),
    },
    autoPrepare: yamlConfig.autoPrepare,
    reminders: yamlConfig.reminders,
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
