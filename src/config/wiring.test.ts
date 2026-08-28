import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { load as parseYaml } from 'js-yaml';

/**
 * The shipped wiring, checked against the collectors that exist.
 *
 * `wiring.contextCollectors` names collectors by string, so a missing name
 * is not an error — it is a feature that silently stops existing. That is
 * what happened to local reviews: `localRepoDiffContext` was left out of
 * `config/config.yaml` (the schema default and `config.example.yaml` both
 * had it), so nothing collected the directory, and every "path ver ve
 * incele" run finished by reporting that no GitLab branch was linked to the
 * Jira issue — an issue there never was.
 *
 * Listing all of them is always correct: every collector inspects the event
 * and returns `{}` when it is not its own (`jiraIssueContext` wants an
 * issue key, `gitlabBranchDiffContext` bails the moment it sees a
 * `repoPath`, `localRepoDiffContext` needs one). So the two entry points
 * share one wiring, and the only way to get this wrong is to omit a name.
 */

/** Every collector `buildRegistry` knows how to construct. Kept as a literal
 * rather than imported: the registry builds real clients on import, and this
 * is a question about a config file. */
const COLLECTORS = ['jiraIssueContext', 'gitlabBranchDiffContext', 'localRepoDiffContext'];

const wiringOf = (path: string) =>
  (parseYaml(readFileSync(path, 'utf-8')) as { wiring: { contextCollectors: string[] } }).wiring;

/**
 * The committed one, and the local one if this machine has it.
 *
 * `config/config.yaml` is gitignored — it holds real credentials — so it
 * exists on a developer's machine and nowhere else, and asserting on it
 * unconditionally fails CI for a file CI was never given. The example is
 * the artifact that actually ships: a fresh install with no config of its
 * own falls back to it (see loadConfig). The local file is still worth
 * checking when it is there, because a config written before a collector
 * existed is exactly how this went wrong.
 */
const CONFIGS = ['config/config.example.yaml', 'config/config.yaml'].filter((p) => existsSync(p));

describe('shipped config', () => {
  it('has something to check', () => {
    // The example is committed; if it is missing, the filter above would
    // quietly leave nothing to test and every assertion below would pass.
    expect(CONFIGS).toContain('config/config.example.yaml');
  });

  it.each(CONFIGS)('%s wires every context collector', (path) => {
    expect(wiringOf(path).contextCollectors).toEqual(expect.arrayContaining(COLLECTORS));
  });

  it('registry knows every collector the config names', () => {
    // The other direction: a name nobody can build makes the app refuse to
    // start, which is at least loud — but it should never ship that way.
    for (const path of CONFIGS) {
      for (const name of wiringOf(path).contextCollectors) {
        expect(COLLECTORS).toContain(name);
      }
    }
  });
});
