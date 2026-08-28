/** Formatting a person reads, shared by the views that show the same facts
 * in different tables. */

const STATUS_TR: Record<string, string> = {
  idle: 'bekliyor',
  cancelled: 'durduruldu',
  queued: 'kuyrukta',
  running: 'çalışıyor',
  awaiting_approval: 'onay bekliyor',
  approved: 'onaylandı',
  rejected: 'reddedildi',
  posted: "Jira'ya yazıldı",
  failed: 'hata',
};

export function statusLabel(status: string): string {
  return STATUS_TR[status] ?? status;
}

export function formatDate(iso?: string | null): string {
  if (!iso) return '—';
  return String(iso).replace('T', ' ').slice(0, 16);
}

/** How long ago, in the coarsest unit that still says something: minutes
 * inside an hour, hours inside two days, then days. */
export function sinceText(iso: string, now = Date.now()): string {
  const ms = now - Date.parse(iso);
  if (!isFinite(ms) || ms < 0) return '—';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes} dk`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} saat`;
  return `${Math.floor(hours / 24)} gün`;
}

/**
 * How far into a run a step happened, as `mm:ss`.
 *
 * Read while watching a log scroll: the wall clock says *when*, this says
 * *how long it has been going*, which is the question someone asks when a
 * run looks stuck. Minutes are not wrapped at 60 — `+72:05` is longer than
 * `+12:05` at a glance, where `1:12:05` invites a second look.
 */
export function elapsedText(fromIso: string, atIso: string): string {
  const ms = Date.parse(atIso) - Date.parse(fromIso);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const total = Math.floor(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
