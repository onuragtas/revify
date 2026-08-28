import { computed, reactive } from 'vue';

/**
 * What the update is doing, said once.
 *
 * Two surfaces show it — the banner across the top and the row in Settings —
 * and they were written separately, which showed: Settings said "yeni sürüm
 * var: 0.1.27" and then went quiet, because the progress and the install
 * button only ever existed in a banner the settings modal covers. One
 * description, rendered twice, is what stops them drifting again.
 */
export interface UpdateInfo {
  supported?: boolean;
  status?: 'idle' | 'downloading' | 'ready' | 'installing' | 'manual';
  version?: string;
  current?: string;
  percent?: number;
  error?: string;
}

export const update = reactive({ info: {} as UpdateInfo, dismissed: readDismissed() });

const DISMISS_KEY = 'ar-dismissed-update';

function readDismissed(): string {
  try {
    return localStorage.getItem(DISMISS_KEY) ?? '';
  } catch {
    return '';
  }
}

export interface UpdateState {
  /** True while something is actually happening — the banner's condition. */
  live: boolean;
  text: string;
  /** The button's label, or null when there is nothing to press. */
  action: string | null;
}

export function describeUpdate(info: UpdateInfo): UpdateState {
  // The browser build has no updater, and there is nothing useful to say
  // about a version nobody can replace from here.
  if (!info.supported) {
    return { live: false, text: 'Geliştirme sürümü — güncelleme kontrolü yok.', action: null };
  }
  if (info.status === 'downloading') {
    return { live: true, text: `Revify ${info.version ?? ''} indiriliyor… %${info.percent ?? 0}`, action: null };
  }
  if (info.status === 'installing') {
    return { live: true, text: 'Kuruluyor, uygulama birazdan yeniden başlayacak…', action: null };
  }
  if (info.status === 'manual') {
    // Only reached when the swap itself failed — the reason travels with it,
    // because "open the download page" without one reads like the update was
    // never possible.
    return {
      live: true,
      text: `Revify ${info.version ?? ''} kurulamadı${info.error ? ` (${info.error})` : ''}.`,
      action: 'İndirme sayfasını aç',
    };
  }
  if (info.status === 'ready') {
    // It installs itself once nothing is running; the button is for "now",
    // not for "at all". Saying so stops it reading like a demand.
    return {
      live: true,
      text: `Revify ${info.version} indirildi — çalışan review kalmayınca kendiliğinden kurulacak.`,
      action: 'Şimdi kur',
    };
  }
  // Nothing in flight: only Settings has room to say so, and "you are up to
  // date" is the answer somebody opening it came for.
  return { live: false, text: `Sürüm ${info.current ?? '?'} — güncel.`, action: null };
}

export const updateState = computed(() => describeUpdate(update.info));

/** Shown in the banner only while something is happening and it has not been
 * dismissed for this version. */
export const bannerVisible = computed(
  () => updateState.value.live && update.info.version !== update.dismissed,
);

let downloadPoll: ReturnType<typeof setTimeout> | null = null;

export async function pollUpdate(): Promise<void> {
  try {
    update.info = await (await fetch('/api/update')).json();
  } catch {
    return;
  }
  // A percentage that moves every thirty seconds is not progress. While
  // bytes are actually arriving, ask more often — and only one chain at a
  // time, or every poll would start another.
  if (update.info.status === 'downloading' && !downloadPoll) {
    downloadPoll = setTimeout(() => {
      downloadPoll = null;
      void pollUpdate();
    }, 2000);
  }
}

export async function checkForUpdate(): Promise<string> {
  const data = await (await fetch('/api/update/check', { method: 'POST' })).json();
  // An error is the one thing the shared description cannot know about;
  // everything else it says better, and keeps saying as the download runs.
  if (data.error) return String(data.error);
  await pollUpdate();
  return '';
}

export async function installUpdate(): Promise<string> {
  const data = await (await fetch('/api/update/install', { method: 'POST' })).json();
  // The most likely refusal is a running review: restarting would kill it
  // and lose work that cannot be resumed.
  if (data.error) return String(data.error);
  await pollUpdate();
  return '';
}

export function dismissUpdate(): void {
  update.dismissed = update.info.version ?? '';
  try {
    localStorage.setItem(DISMISS_KEY, update.dismissed);
  } catch {
    /* not remembering it is the whole cost */
  }
}
