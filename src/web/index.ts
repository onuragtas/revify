import { loadConfigOrExit } from '../config/loadConfig.js';
import { buildPipeline } from '../core/registry.js';
import { createServer } from './server.js';

// Interactive mode: nothing runs automatically. Open the page, refresh the
// list, pick an issue, watch it run, approve or reject.
const config = loadConfigOrExit();
const wired = buildPipeline(config);

const port = Number(process.env.UI_PORT ?? 4321);
const app = createServer(config, wired);

const server = app.listen(port, () => {
  console.log(`Revify UI running at http://localhost:${port}`);
  if (config.autoPrepare.enabled && config.setup.configured) {
    // Worth stating plainly: this is the one thing that runs on its own.
    // It only *prepares* a review — nothing reaches Jira without a click.
    console.log(
      `Auto-prepare is on (every ${config.autoPrepare.pollIntervalMs / 1000}s). ` +
        'New issues are reviewed as they arrive; approving stays yours.',
    );
    app.autoPrepare.start();
  } else if (config.autoPrepare.enabled) {
    // Enabled but with nothing to poll for. Started anyway it asked Jira an
    // empty question every couple of minutes, and Jira refused every one —
    // an error loop that says nothing about the actual problem, which is
    // that this machine has no team policy yet.
    console.log(`Auto-prepare is waiting for setup: ${config.setup.missing.join(', ')}`);
  } else {
    console.log('Nothing runs automatically — open the page and pick an issue to review.');
  }

  // Reminders run in the plain web mode too. There is no desktop
  // notification here, but the events still drive the page's own list —
  // and the log line is what tells someone running headless what is piling
  // up on them.
  if (config.reminders.enabled) app.reminders.start();
});

/**
 * Ctrl+C has to actually exit.
 *
 * Nothing here closed on a signal before: the HTTP listener kept the event
 * loop alive, and the browser's polling held keep-alive sockets open
 * indefinitely, so `tsx` waited for a graceful exit that was never coming
 * and force-killed after five seconds. Worse, a review in flight runs in a
 * *detached* process — it survives the parent by design, so leaving without
 * aborting it orphans a `claude` process that keeps working for nobody.
 */
let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  // A second Ctrl+C means "stop asking nicely".
  if (shuttingDown) process.exit(1);
  shuttingDown = true;
  console.log(`\n${signal} received — stopping.`);

  app.shutdown();
  server.close(() => process.exit(0));
  // Idle keep-alive sockets would otherwise hold `close` open for as long
  // as the page stays on screen.
  server.closeAllConnections?.();

  // Backstop: an in-flight request or a slow socket must not turn a
  // shutdown into a hang.
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
