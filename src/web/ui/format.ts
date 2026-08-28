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
