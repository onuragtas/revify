import { reactive, ref } from 'vue';
import { state, type DetailPayload } from './bridge';

/**
 * The once-a-second poll behind the detail panel.
 *
 * Polling rather than a stream: an SSE endpoint was tried first and proved
 * fragile, while plain polling always shows the full picture. It stops on
 * its own once a review settles — there is nothing left to ask for, and it
 * would only rebuild the screen under the reader's cursor.
 */
const POLL_MS = 1000;

/** Once a review reaches one of these, nothing changes until somebody acts. */
const SETTLED = ['awaiting_approval', 'approved', 'rejected', 'posted', 'failed', 'cancelled'];
const FIX_BUSY = ['queued', 'running'];

export const connection = reactive({ error: '' });

let timer: ReturnType<typeof setInterval> | undefined;
/**
 * Which polling run owns the screen.
 *
 * A request already in flight when a new run starts belongs to the previous
 * one, and its answer describes the state *before* whatever just began:
 * letting it paint shows a stale screen, and letting it stop the poll kills
 * the run that replaced it. That is exactly how the step log froze the
 * moment a review was started from an already-finished one.
 */
let generation = 0;

export function stopPolling(): void {
  clearInterval(timer);
  timer = undefined;
}

export async function pollDetail(issueKey: string, run = generation): Promise<void> {
  try {
    const detail: DetailPayload = await (
      await fetch(`/api/reviews/${encodeURIComponent(issueKey)}/detail`)
    ).json();
    if (run !== generation) return;

    connection.error = '';
    state.detail = detail;

    // A settled review has nothing left to poll for — unless a fix is
    // running against it, which has its own steps and its own ending.
    const fixRunning = FIX_BUSY.includes(detail.fix?.status ?? '');
    if (SETTLED.includes(detail.status ?? '') && !fixRunning) stopPolling();
  } catch {
    connection.error = 'bağlantı hatası, yeniden deneniyor…';
  }
}

export function startPolling(issueKey: string): void {
  stopPolling();
  const run = ++generation;
  void pollDetail(issueKey, run);
  timer = setInterval(() => void pollDetail(issueKey, run), POLL_MS);
}

/* --------------------------------- meta ---------------------------------- */

export interface IssueMeta {
  summary?: string;
  description?: string;
  issueType?: string;
  status?: string;
  assignee?: string;
  reporter?: string;
  sprint?: string;
  priority?: string;
  updated?: string;
  changedRepos?: Array<{ branch: string; repositoryUrl: string }>;
  error?: string;
}

export const meta = ref<IssueMeta | null>(null);
export const metaError = ref('');

/** Jira's own view of the issue: the description, the chips, and which
 * branches it links. A separate call because it costs a Jira round trip and
 * the detail poll must stay cheap. */
export async function loadMeta(issueKey: string): Promise<void> {
  meta.value = null;
  metaError.value = '';
  try {
    const data: IssueMeta = await (
      await fetch(`/api/reviews/${encodeURIComponent(issueKey)}/prepare`)
    ).json();
    // The reader moved on while this was loading.
    if (state.issueKey !== issueKey) return;
    if (data.error) {
      metaError.value = `Hata: ${data.error}`;
      return;
    }
    meta.value = data;
  } catch (err) {
    metaError.value = `Jira detayları yüklenemedi: ${(err as Error).message}`;
  }
}

/* -------------------------------- opening -------------------------------- */

/** Which detail tab is showing, and whether the reader chose it. */
export const tabs = reactive({ active: 'review', pinned: false, counts: {} as Record<string, { count: number; alert: boolean }> });

export function showTab(name: string, { pin = true } = {}): void {
  tabs.active = name;
  if (pin) tabs.pinned = true;
}

export function setTabCount(name: string, count: number, alert = false): void {
  tabs.counts = { ...tabs.counts, [name]: { count, alert } };
}

/**
 * Show an issue's existing review without running anything.
 *
 * The selection goes in the URL hash so a page refresh comes back to it.
 * Re-opening the issue already on screen is ignored unless forced — it would
 * restart polling and close whatever the reader just opened.
 */
export function openIssue(issueKey: string, { force = false } = {}): void {
  if (issueKey === state.issueKey && !force) return;

  state.issueKey = issueKey;
  state.detail = null;
  tabs.pinned = false;
  tabs.active = 'review';
  connection.error = '';

  if (decodeURIComponent(location.hash.slice(1)) !== issueKey) {
    history.replaceState(null, '', `#${encodeURIComponent(issueKey)}`);
  }

  void loadMeta(issueKey);
  startPolling(issueKey);
}

/**
 * Start (or restart) a review, with whatever the context picker selected.
 *
 * Shared because two screens ask for it: the button in the detail header,
 * and "save and re-review" in Doğrulama. To the person pressing either, it
 * is one act.
 */
export async function startReview(issueKey: string, contextRepos: string[] = []): Promise<void> {
  openIssue(issueKey, { force: true });
  showTab('process', { pin: false });

  await fetch(`/api/reviews/${encodeURIComponent(issueKey)}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contextRepos }),
  }).catch(() => {});

  // Only now is the record 'queued'. The poll `openIssue` started read the
  // status as it was before this request — for an issue already reviewed
  // that reads as "settled", and it would stop polling a run just beginning.
  startPolling(issueKey);
}

/**
 * Ask the backend for the team's current notes, then re-poll.
 *
 * A note a colleague added is not this machine's to know until it asks, and
 * the detail poll's own sync is throttled to a minute — right for a loop,
 * wrong for a deliberate click.
 */
export async function refreshNotes(): Promise<void> {
  try {
    await fetch('/api/notes');
  } catch {
    /* the cached list stays on screen, which is the truth we have */
  }
  if (state.issueKey) void pollDetail(state.issueKey);
}
