import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JiraAttachment } from '../clients/jiraClient.js';

/**
 * Brings an issue's attachments down to disk so the model can read them.
 *
 * A spec, an integration PDF, a screenshot of the flow — these are often
 * where the actual requirement lives, and until now the reviewer could not
 * even see that they existed. The model's Read tool handles PDFs and
 * images, so the whole mechanism is: fetch the useful ones into a
 * directory, and mount that directory.
 *
 * "Useful" needs bounds, and they are here rather than in the Jira client
 * because they are a policy, not a fact about Jira:
 *
 *   - **Type.** A .docx or a .zip cannot be read as text and would only
 *     spend tokens on the attempt. Unreadable ones are still *named* in
 *     the prompt, which is more honest than pretending they do not exist.
 *   - **Size.** A 40 MB PDF is a slow download and a large read for
 *     something that is usually a scan of a diagram.
 *   - **Count.** Issues accumulate screenshots. Ten is enough to carry
 *     the specification; a hundred is someone's bug-report history.
 */

/** Extensions the model can actually read. Kept as extensions rather than
 * mime types because Jira's mimeType is frequently wrong or empty. */
const READABLE = new Set([
  '.pdf', '.txt', '.md', '.csv', '.json', '.yaml', '.yml', '.xml', '.log',
  '.png', '.jpg', '.jpeg', '.gif', '.webp',
  '.sql', '.http', '.har',
]);

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 10;

export interface AttachmentPlan {
  /** Downloaded and mounted for the model to read. */
  fetched: Array<{ filename: string; path: string; size: number }>;
  /** Named in the prompt but not downloaded, with why. */
  skipped: Array<{ filename: string; reason: string }>;
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot).toLowerCase();
}

/** Anything that could climb out of the directory, or collide with a real
 * file in it. Jira filenames come from users and are not path-safe. */
function safeName(filename: string, index: number): string {
  const cleaned = filename.replace(/[/\\]/g, '_').replace(/^\.+/, '_').slice(0, 120);
  return cleaned || `attachment-${index}`;
}

export async function fetchAttachments(
  attachments: JiraAttachment[],
  dir: string,
  download: (contentUrl: string) => Promise<Buffer>,
  log?: (message: string) => void,
): Promise<AttachmentPlan> {
  const plan: AttachmentPlan = { fetched: [], skipped: [] };
  if (!attachments.length) return plan;

  // Cleared each run: an attachment removed from the issue must not linger
  // and be read as though it were still part of the specification.
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  let index = 0;
  for (const attachment of attachments) {
    if (plan.fetched.length >= MAX_FILES) {
      plan.skipped.push({ filename: attachment.filename, reason: `ilk ${MAX_FILES} dosya sınırı` });
      continue;
    }
    const extension = extensionOf(attachment.filename);
    if (!READABLE.has(extension)) {
      plan.skipped.push({ filename: attachment.filename, reason: `okunamayan tür (${extension || 'uzantısız'})` });
      continue;
    }
    if (attachment.size > MAX_BYTES) {
      plan.skipped.push({
        filename: attachment.filename,
        reason: `çok büyük (${Math.round(attachment.size / 1024 / 1024)} MB)`,
      });
      continue;
    }
    if (!attachment.contentUrl) {
      plan.skipped.push({ filename: attachment.filename, reason: 'indirme adresi yok' });
      continue;
    }

    try {
      const bytes = await download(attachment.contentUrl);
      const name = safeName(attachment.filename, index++);
      const path = join(dir, name);
      writeFileSync(path, bytes);
      plan.fetched.push({ filename: attachment.filename, path, size: bytes.length });
    } catch (err) {
      // One file failing is not the review failing. It is named as skipped
      // so the reader knows something was there and did not arrive.
      const reason = err instanceof Error ? err.message : String(err);
      plan.skipped.push({ filename: attachment.filename, reason: `indirilemedi: ${reason}` });
      log?.(`${attachment.filename} indirilemedi: ${reason}`);
    }
  }

  return plan;
}
