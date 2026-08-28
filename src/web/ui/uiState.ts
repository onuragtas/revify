import { reactive } from 'vue';

/**
 * Which overlays are open.
 *
 * One place rather than a flag per component: a modal is opened from
 * somewhere else — a toolbar button, an empty list, a keyboard shortcut —
 * and the thing doing the opening should not have to hold a reference to the
 * thing being opened.
 */
export type ModalName = 'backup' | 'context' | 'assign' | 'team' | 'settings';

export const modals = reactive<Record<ModalName, boolean>>({
  backup: false,
  context: false,
  assign: false,
  team: false,
  settings: false,
});

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
