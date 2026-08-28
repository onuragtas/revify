import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
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

describe('shipped config', () => {
  it.each(['config/config.yaml', 'config/config.example.yaml'])(
    '%s wires every context collector',
    (path) => {
      expect(wiringOf(path).contextCollectors).toEqual(expect.arrayContaining(COLLECTORS));
    },
  );

  it('registry knows every collector the config names', () => {
    // The other direction: a name nobody can build makes the app refuse to
    // start, which is at least loud — but it should never ship that way.
    for (const path of ['config/config.yaml', 'config/config.example.yaml']) {
      for (const name of wiringOf(path).contextCollectors) {
        expect(COLLECTORS).toContain(name);
      }
    }
  });
});
