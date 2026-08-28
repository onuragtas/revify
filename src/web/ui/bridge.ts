import { reactive, type App, createApp, type Component } from 'vue';
import { openModal } from './uiState';
import {
  openIssue,
  refreshNotes,
  setTabCount,
  showTab,
  startPolling,
  startReview,
} from './detail';
import { setViewCount } from './views';

/**
 * The state every screen reads from.
 *
 * One `/detail` poll writes here and the components render off it, so no two
 * of them can disagree about what is on screen or ask for the same thing
 * twice. This began as the seam between the hand-written page and Vue; the
 * page is gone, and what is left is simply the store.
 *
 * Every field is optional and every component must render with nothing in
 * it: an island can mount before the first poll has answered.
 */
/*
 * The payload's shape lives in `core/apiTypes.ts`, with the handler that
 * sends it.
 *
 * It used to be declared here as well, by hand. Two copies with nothing
 * binding them means a field renamed on the server compiles cleanly on both
 * sides and this panel silently goes blank. The import is type-only, so the
 * bundle never follows it into Node's standard library.
 */
export type {
  FindingView,
  FixPatchView,
  FixView,
  ReviewDetail,
  Severity,
} from '../../core/apiTypes.js';

/**
 * What the page has handed over so far.
 *
 * `Partial` because an island can mount before the first poll answers, and
 * because a component must render with nothing in it rather than throw.
 */
export type DetailPayload = Partial<import('../../core/apiTypes.js').ReviewDetail>;

export const state = reactive({
  /** The issue currently open, or null on the list view. */
  issueKey: null as string | null,
  /** The last `/detail` response, verbatim. */
  detail: null as DetailPayload | null,
});

/** Somewhere for a component to say "the list changed" without the page
 * having to notice — a review started from the key box belongs in the list
 * the moment it starts. */
export const listRefresh = reactive({ token: 0 });

export function refreshList(): void {
  listRefresh.token++;
}

const mounted = new Map<string, App>();

/**
 * Views that can be told to re-fetch.
 *
 * The page still owns the tab bar, so "the user opened Kararlar" is an event
 * only it sees — and the view that has to answer it lives in Vue. A name per
 * view is enough of a seam, and it disappears with the tab bar.
 */
const reloaders = new Map<string, () => void>();

export function registerReloader(name: string, load: () => void): void {
  reloaders.set(name, load);
}

export function reloadView(name: string): void {
  reloaders.get(name)?.();
}

/**
 * Mounts a component into an element the old page already renders.
 *
 * A missing element is not an error: the container may belong to a screen
 * this build has not migrated, and an island that cannot find its home
 * should stay silent rather than take the page down with it.
 */
export function island(selector: string, component: Component): void {
  const element = document.querySelector(selector);
  if (!element || mounted.has(selector)) return;
  const app = createApp(component);
  app.mount(element);
  mounted.set(selector, app);
}

/* ------------------------------- the host --------------------------------- */

/*
 * What used to be a seam is now just the app.
 *
 * While the hand-written page still owned routing, the tab bar and the poll,
 * a component that started a fix could not restart polling or move a badge
 * itself — it called back through `window`. The page is gone, so these are
 * the real implementations, kept behind one object so the components that
 * grew up calling `host.x` did not all have to change on the same day.
 */
export const host = {
  startPolling,
  setTabCount,
  showTab,
  startReview,
  refreshNotes,
  openIssue,
  setViewCount,
  /** The one screen that fixes a first run with no credentials. */
  openSettings: () => openModal('settings'),
};
