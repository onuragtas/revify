import { reactive } from 'vue';

/**
 * What this machine will actually do when a decision is made.
 *
 * `applyChanges` is the one that matters: with it off, approving writes
 * nothing to Jira and only logs what it would have done. Every screen that
 * offers a decision says which of the two it is, because the buttons look
 * identical either way.
 */
export const outcomeConfig = reactive({
  loaded: false,
  applyChanges: false,
  approveStatus: '',
  rejectStatus: '',
  jiraBaseUrl: '',
});

export const autoPrepare = reactive({ enabled: false, since: '', lastReviewAt: '' });

export async function loadOutcomeConfig(): Promise<void> {
  try {
    const data = await (await fetch('/api/outcome-config')).json();
    Object.assign(outcomeConfig, data, { loaded: true });
  } catch {
    /* the chip stays blank rather than the screen failing */
  }
}

export async function loadAutoPrepare(): Promise<void> {
  try {
    Object.assign(autoPrepare, await (await fetch('/api/auto-prepare')).json());
  } catch {
    /* same */
  }
}
