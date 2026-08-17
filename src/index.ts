import { loadConfigOrExit } from './config/loadConfig.js';
import { buildPipeline } from './core/registry.js';
import { Pipeline } from './core/pipeline.js';

// Headless/automatic mode: polls Jira and the approval channel on a timer,
// no human interaction needed to start it. For the interactive web UI
// (nothing runs until you pick an issue), use `npm run ui` instead.
const config = loadConfigOrExit();
const wired = buildPipeline(config);
const pipeline = new Pipeline(config, wired);

console.log('auto-reviewer starting (automatic mode)');
console.log(`  trigger poll every ${config.pollIntervalMs}ms`);
console.log(`  approval poll every ${config.approvalPollIntervalMs}ms`);
console.log(`  wiring: ${JSON.stringify(config.wiring)}`);

pipeline.start();
