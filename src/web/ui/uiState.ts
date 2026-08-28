import { reactive } from 'vue';

/**
 * Which overlays are open.
 *
 * One place rather than a flag per component: a modal is opened from
 * somewhere else — a toolbar button, an empty list, a keyboard shortcut —
 * and the thing doing the opening should not have to hold a reference to the
 * thing being opened.
 */
export type ModalName = 'backup' | 'context' | 'assign' | 'team' | 'settings' | 'localReview';

export const modals = reactive<Record<ModalName, boolean>>({
  backup: false,
  context: false,
  assign: false,
  team: false,
  settings: false,
  localReview: false,
});

/**
 * The directory a local review is about to be started from.
 *
 * Set by the sidebar when its inspect call comes back, read by the dialog
 * that asks whether the branch's ticket is the right one. Shared for the
 * same reason `contextSelection` is: the thing that opens a modal and the
 * modal itself should not have to hold references to each other.
 */
export const localReviewTarget = reactive<{ path: string }>({ path: '' });

export function openModal(name: ModalName): void {
  modals[name] = true;
}

export function closeModal(name: ModalName): void {
  modals[name] = false;
}

/** Escape closes whatever is open — one handler rather than one per modal,
 * and it cannot fall out of sync with the set above. */
export function closeAllModals(): void {
  for (const name of Object.keys(modals) as ModalName[]) modals[name] = false;
}

/**
 * The context repositories the picker has selected.
 *
 * Shared rather than owned by the picker because the thing that *uses* it —
 * starting a review — still lives in the page, and a modal that has been
 * closed cannot be asked. It is the picker's output, not its state.
 */
export const contextSelection = reactive<{ repos: string[] }>({ repos: [] });
