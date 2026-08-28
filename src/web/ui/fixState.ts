import { computed, reactive } from 'vue';
import { state } from './bridge';

/**
 * What the Düzelt button, its modal and the Yama panel all need to agree on.
 *
 * They are three containers in three different corners of the page — the
 * header, a modal at the end of the body, and a tab panel — so the thing
 * they share cannot live inside any one of them.
 */
export const fixUi = reactive({ modalOpen: false });

const FIXABLE = ['blocking', 'major'];

export const findings = computed(() => state.detail?.findings ?? []);

/** Findings a human has disputed, by heading. An objection only takes effect
 * on the next review; until then the finding is still in the review text,
 * and offering to fix it by default would be the tool contradicting the
 * person using it. */
export const disputes = computed(
  () =>
    new Map(
      (state.detail?.challenges ?? [])
        .filter((c) => (c.objection ?? '').trim())
        .map((c) => [c.finding, c.objection] as const),
    ),
);

export const revisionPending = computed(() => Boolean((state.detail?.revisionRequest ?? '').trim()));

/** Checked when the modal opens: blocking and major, minus anything
 * disputed. A minor is a nit, and a patch nobody asked for is noise in
 * someone's working copy. */
export function checkedByDefault(heading: string, severity: string): boolean {
  return !disputes.value.has(heading) && FIXABLE.includes(severity);
}

export const fix = computed(() => state.detail?.fix ?? null);
export const busy = computed(() => fix.value?.status === 'queued' || fix.value?.status === 'running');

/** False when this machine's provider has no file tools, or the review was
 * produced without a checkout. The button says why rather than vanishing. */
export const available = computed(() => Boolean(state.detail?.fixAvailable));
