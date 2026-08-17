import { app, BrowserWindow, Menu, Notification, Tray, nativeImage, shell } from 'electron';
import type { AddressInfo } from 'node:net';
import { loadConfigOrExit } from '../config/loadConfig.js';
import { buildPipeline } from '../core/registry.js';
import { createServer } from '../web/server.js';

/**
 * The desktop shell.
 *
 * It is a shell and nothing more: the same Express server and the same
 * single-page UI as `npm run ui`, hosted inside Electron so the app can do
 * the two things a browser tab cannot — sit in the tray while closed, and
 * interrupt you when a review is ready.
 *
 * The server runs in this process rather than as a child. That keeps the
 * review events in-process (no polling, no IPC round trip for a
 * notification) and means one lifecycle to manage instead of two: when this
 * process goes, the server and any running review go with it.
 */

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let baseUrl = '';

/*
 * A packaged build is a release, and a release talks to the deployed
 * backend.
 *
 * This used to be "baked in at build time" by setting REVIFY_ENV while CI
 * ran `npm run build` — which did nothing at all. tsc does not substitute
 * environment variables; backendUrl() reads REVIFY_ENV when it is *called*,
 * and the installed app has no such variable. So every release shipped
 * pointing at http://localhost:4322.
 *
 * Being packaged is the honest signal, and it cannot be forgotten in a
 * workflow file. An explicit REVIFY_ENV still wins, for anyone pointing a
 * build at a staging server.
 */
if (app.isPackaged && !process.env.REVIFY_ENV) process.env.REVIFY_ENV = 'production';

const config = loadConfigOrExit();
const wired = buildPipeline(config);
const server = createServer(config, wired);

/** A tray icon drawn here rather than shipped as a file: one less asset to
 * keep in sync, and a template image adapts to light and dark menu bars on
 * its own. */
function trayIcon(): Electron.NativeImage {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">
    <path d="M4.5 7.5 L9 12 L4.5 16.5" fill="none" stroke="black" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round"/>
    <line x1="11.5" y1="16.5" x2="17.5" y2="16.5" stroke="black" stroke-width="2"
          stroke-linecap="round"/>
  </svg>`;
  const image = nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
  );
  image.setTemplateImage(true);
  return image;
}

function showWindow(): void {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** Opens an issue in the already-loaded page. The UI watches the hash, so
 * this costs nothing — reloading the URL would throw away the step log and
 * whatever the reader had open. */
function openIssue(issueKey: string): void {
  showWindow();
  const hash = JSON.stringify(encodeURIComponent(issueKey));
  mainWindow?.webContents.executeJavaScript(`location.hash = ${hash}`).catch(() => {
    /* page not ready yet; the user is looking at it anyway */
  });
}

/** `silent` is the difference between "something needs you" and "you may
 * want to know": a sound for every issue the watcher picks up would train
 * you to ignore the ones that actually wait on a decision. */
function notify(title: string, body: string, onClick?: () => void, silent = false): void {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body, silent });
  if (onClick) notification.on('click', onClick);
  notification.show();
}

/** The count of reviews waiting on a decision, shown wherever the platform
 * has somewhere to put it. */
function refreshBadge(): void {
  const count = server.pendingCount();
  tray?.setToolTip(count ? `Revify — ${count} onay bekliyor` : 'Revify');
  // A tray title is a macOS affordance; elsewhere it is simply ignored.
  tray?.setTitle(count ? String(count) : '');
  if (process.platform === 'darwin') app.dock?.setBadge(count ? String(count) : '');
  buildTrayMenu();
}

function buildTrayMenu(): void {
  if (!tray) return;
  const count = server.pendingCount();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: count ? `${count} review onay bekliyor` : 'Bekleyen review yok', enabled: false },
      { type: 'separator' },
      { label: 'Pencereyi aç', click: () => showWindow() },
      { label: 'Tarayıcıda aç', click: () => void shell.openExternal(baseUrl) },
      { type: 'separator' },
      {
        label: 'Çık',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 480,
    minHeight: 480,
    title: 'Revify',
    // The page is our own and needs no Node access; keeping the renderer
    // sandboxed means a bug in the review markdown can never reach the
    // filesystem or the Jira credentials this process holds.
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    show: false,
  });

  void mainWindow.loadURL(baseUrl);
  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // Closing hides rather than quits: a tray app that dies when you close
  // its window cannot tell you anything afterwards, which is the whole
  // reason it is in the tray.
  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow?.hide();
  });
  mainWindow.on('closed', () => (mainWindow = null));

  // Anything that isn't our own page belongs in the real browser — a Jira
  // link should not open in a window with no address bar.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(baseUrl)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });
}

/**
 * Update checking, against the GitHub releases this repository publishes.
 *
 * What works where is not uniform, and pretending otherwise would produce a
 * button that silently fails:
 *
 * - **Linux (AppImage)** — downloads and installs. No signing required.
 * - **macOS** — Squirrel refuses to apply an update to an unsigned app, and
 *   our releases are unsigned on purpose (certificates are secrets that
 *   fork pull requests must never see). So the app *notices* the new
 *   version and offers the download page instead of a broken install.
 *
 * Nothing installs itself. A restart mid-review would kill the `claude`
 * process and lose work that cannot be resumed, so the decision stays with
 * whoever is using it — and the server refuses while a review is running.
 */
async function setupUpdates(): Promise<void> {
  // A dev run has no packaged app to replace, and checking would only
  // produce a confusing error.
  if (!app.isPackaged) {
    server.setUpdateState({ supported: false, reason: 'development build' });
    return;
  }

  /*
   * Loaded here rather than at the top of the file.
   *
   * A static import made the updater a condition of starting at all: it
   * was packaged as a devDependency, electron-builder ships only
   * `dependencies`, and the installed app died on its first line with
   * ERR_MODULE_NOT_FOUND — before a window, with the reason in a console
   * nobody sees. The dependency is where it belongs now; this makes sure
   * that being wrong about it again costs the update check, not the app.
   */
  let autoUpdater: typeof import('electron-updater').autoUpdater;
  try {
    ({ autoUpdater } = (await import('electron-updater')).default);
  } catch (err) {
    console.error('[updater] unavailable:', err);
    server.setUpdateState({ supported: false, reason: 'updater not available in this build' });
    return;
  }
  // Downloading is fine unattended; installing is not.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  const canInstall = process.platform !== 'darwin';
  const current = app.getVersion();

  const publish = (state: Record<string, unknown>) =>
    server.setUpdateState({ supported: true, canInstall, current, ...state });

  publish({ status: 'idle' });

  autoUpdater.on('checking-for-update', () => publish({ status: 'checking' }));
  autoUpdater.on('update-not-available', () => publish({ status: 'current' }));
  autoUpdater.on('download-progress', (p) =>
    publish({ status: 'downloading', percent: Math.round(p.percent) }),
  );

  autoUpdater.on('update-available', (info) => {
    publish({ status: 'downloading', version: info.version, percent: 0 });
    if (!canInstall) {
      // Nothing will be installed here, so say so now rather than after a
      // download that leads to a dead end.
      publish({ status: 'manual', version: info.version, url: releasesUrl() });
      notify('Yeni sürüm var', `Revify ${info.version} yayınlandı.`, () => void shell.openExternal(releasesUrl()));
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    publish({ status: 'ready', version: info.version });
    notify('Güncelleme hazır', `Revify ${info.version} kurulmayı bekliyor.`, () => showWindow());
  });

  autoUpdater.on('error', (err) => {
    // Update failures must not interrupt anyone: the app it is trying to
    // replace is working.
    console.error('[updater]', err);
    publish({ status: 'error', error: err?.message ?? String(err) });
  });

  server.setUpdateState({ supported: true, canInstall, current, status: 'idle' }, () => {
    if (canInstall) autoUpdater.quitAndInstall(false, true);
    else void shell.openExternal(releasesUrl());
  });

  const check = () => {
    lastCheckedAt = new Date().toISOString();
    return autoUpdater.checkForUpdates().catch((err) => {
      console.error('[updater] check failed:', err);
      return null;
    });
  };

  // Checking is cheap — one request for a small YAML file — and the cost
  // of checking rarely is real: on macOS an update needs a person to go
  // and fetch it, so a version that appears in the morning should not
  // wait until evening to be mentioned. Hourly, plus whenever the window
  // comes back to the front, which is when someone is actually there to
  // act on it.
  setTimeout(check, 15_000).unref?.();
  setInterval(check, 60 * 60 * 1000).unref?.();

  // Focus is the cheapest possible signal that a person is present. Rate
  // limited to fifteen minutes so alt-tabbing does not hammer GitHub.
  let lastFocusCheck = 0;
  app.on('browser-window-focus', () => {
    const now = Date.now();
    if (now - lastFocusCheck < 15 * 60 * 1000) return;
    lastFocusCheck = now;
    void check();
  });

  // "Check now", from the settings screen. A person who asks should get an
  // answer rather than being told to wait for a timer — and if there is
  // nothing new, saying so plainly is the answer.
  server.setUpdateChecker(async () => {
    const result = await check();
    return {
      checkedAt: lastCheckedAt,
      version: result?.updateInfo?.version ?? current,
      available: Boolean(result?.updateInfo && result.updateInfo.version !== current),
    };
  });
}

/** When the last check ran, so the UI can say "kontrol edildi: 3 dk önce"
 * instead of leaving someone guessing whether it ever happens. */
let lastCheckedAt: string | null = null;

function releasesUrl(): string {
  return 'https://github.com/onuragtas/revify/releases/latest';
}

// A second launch should raise the window that already exists, not start a
// second server on a second port with the same data files underneath it.
if (!app.requestSingleInstanceLock()) {
  // Handing over to the copy that already holds the lock, which raises its
  // window from the `second-instance` handler below. Said out loud because
  // a silent exit is indistinguishable from a launch that failed — and the
  // lock can linger for a moment after a previous instance was killed, so
  // this is also what "I relaunched too fast" looks like.
  console.log('Another Revify instance is already running — bringing it to the front.');
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  void app.whenReady().then(() => {
    // Port 0 lets the OS pick a free one — a fixed port would collide with
    // `npm run ui` and with a second copy of the app.
    const listener = server.listen(0, '127.0.0.1', () => {
      const { port } = listener.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${port}`;
      console.log(`Revify desktop running at ${baseUrl}`);
      // Not before setup is complete: with no JQL to poll, this only
      // produced a Jira error every interval — see web/index.ts.
      if (config.autoPrepare.enabled && config.setup.configured) server.autoPrepare.start();
      // Independent of auto-prepare: even with nothing reviewed here,
      // a colleague can assign you work, and that is what this watches.
      if (config.reminders.enabled) server.reminders.start();
      else if (config.autoPrepare.enabled) {
        console.log(`Auto-prepare is waiting for setup: ${config.setup.missing.join(', ')}`);
      }

      tray = new Tray(trayIcon());
      buildTrayMenu();
      tray.on('click', () => showWindow());

      createWindow();
      refreshBadge();
      // Not awaited: the window is already up, and an update check has no
      // business delaying anything.
      void setupUpdates();
      // Cheap and local: the count also moves when you approve something in
      // the window, which emits nothing.
      setInterval(refreshBadge, 5000).unref();
    });

    server.events.on('review:ready', ({ issueKey, summary }) => {
      refreshBadge();
      notify('Review hazır', `${issueKey}${summary ? ` — ${summary}` : ''}\nOnayını bekliyor.`, () =>
        openIssue(issueKey),
      );
    });

    server.events.on('review:failed', ({ issueKey, error }) => {
      notify('Review başarısız', `${issueKey}\n${error.slice(0, 140)}`, () => openIssue(issueKey));
    });

    server.events.on('review:auto-queued', ({ issueKey, summary, position }) => {
      notify(
        position === 0 ? 'Yeni iş inceleniyor' : 'Yeni iş sıraya alındı',
        `${issueKey}${summary ? ` — ${summary}` : ''}`,
        () => openIssue(issueKey),
        true,
      );
    });

    server.events.on('reminder:due', ({ items, title, body }) => {
      refreshBadge();
      // Clicking opens the oldest of the batch: with one item that is the
      // obvious thing, and with several it is the one that has waited
      // longest — which is the one to look at first anyway.
      const oldest = [...items].sort((a, b) => b.waitedHours - a.waitedHours)[0];
      notify(title, body, oldest ? () => openIssue(oldest.issueKey) : undefined);
    });

    app.on('activate', () => showWindow());
  });

  app.on('before-quit', () => {
    quitting = true;
    // Kills any review in flight. Without it the detached `claude` process
    // outlives the app that started it.
    server.shutdown();
  });

  // The tray is the app; closing every window is not a reason to exit.
  app.on('window-all-closed', () => {
    /* deliberately empty */
  });
}
