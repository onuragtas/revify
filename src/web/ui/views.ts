import { reactive } from 'vue';

/** The four top-level screens, and the badge each carries. */
export type ViewName = 'reviews' | 'pending' | 'assigned' | 'decisions';

export const views = reactive({
  active: 'reviews' as ViewName,
  counts: {} as Record<string, { count: number; alert: boolean }>,
});

export function setViewCount(name: string, count: number, alert = false): void {
  views.counts = { ...views.counts, [name]: { count, alert } };
}
