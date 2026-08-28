/** One place that knows how to talk to the server, so a component never
 * builds a URL by hand and a renamed route breaks in one file. */
async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}) as Record<string, unknown>);
  if ((body as { error?: string }).error) throw new Error((body as { error: string }).error);
  return body as T;
}

const review = (issueKey: string) => `/api/reviews/${encodeURIComponent(issueKey)}`;

export interface StoredPrompt {
  kind: string;
  system: string;
  prompt: string;
  savedAt: string;
}

export function readPrompt(issueKey: string, kind: string): Promise<StoredPrompt> {
  return json<StoredPrompt>(`${review(issueKey)}/prompt?kind=${encodeURIComponent(kind)}`);
}

export interface ApplyResult {
  root: string;
  files: string[];
  merged: boolean;
}

export function startFix(
  issueKey: string,
  findings: string[],
  instructions: Record<string, string>,
): Promise<{ position: number; findings: number }> {
  return json(`${review(issueKey)}/fix`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ findings, instructions }),
  });
}

export function stopFix(issueKey: string): Promise<unknown> {
  return json(`${review(issueKey)}/fix/stop`, { method: 'POST' });
}

export function clearFix(issueKey: string): Promise<unknown> {
  return json(`${review(issueKey)}/fix`, { method: 'DELETE' });
}

export function patchUrl(issueKey: string, projectPath: string, download = false): string {
  return `${review(issueKey)}/fix/patch?projectPath=${encodeURIComponent(projectPath)}${
    download ? '&download=1' : ''
  }`;
}

/** Plain text, not JSON — the patch is the response body. */
export async function readPatch(issueKey: string, projectPath: string): Promise<string> {
  const res = await fetch(patchUrl(issueKey, projectPath));
  if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error);
  return res.text();
}

export function applyPatch(
  issueKey: string,
  projectPath: string,
  path: string,
): Promise<ApplyResult> {
  return json<ApplyResult>(`${review(issueKey)}/fix/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath, path }),
  });
}

export function saveRevision(issueKey: string, text: string): Promise<unknown> {
  return json(`${review(issueKey)}/revision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

export function saveClarifications(
  issueKey: string,
  answers: Array<{ question: string; answer: string }>,
): Promise<unknown> {
  return json(`${review(issueKey)}/clarifications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answers }),
  });
}

export function saveChallenges(
  issueKey: string,
  challenges: Array<{ finding: string; objection: string }>,
): Promise<unknown> {
  return json(`${review(issueKey)}/challenges`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenges }),
  });
}

export function addNote(input: {
  scope: 'global' | 'repo';
  projectPath: string | null;
  text: string;
}): Promise<unknown> {
  return json('/api/notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function deleteNote(id: string): Promise<unknown> {
  return json(`/api/notes/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export interface DecisionRow {
  issueKey: string;
  summary: string | null;
  decision: string;
  decidedAt: string;
  rejectionReason: string | null;
  jiraStatus: string | null;
  assignee: string | null;
  severity: string;
  decidedByName: string | null;
  local: boolean;
}

export function readDecisions(): Promise<{ items: DecisionRow[]; jiraBaseUrl: string }> {
  return json('/api/decisions');
}

export interface AssignmentRow {
  issueKey: string;
  summary?: string;
  note?: string;
  assignedByName?: string;
  assignedAt: string;
  teamId: string;
}

export function readAssignments(): Promise<{ items: AssignmentRow[] }> {
  return json('/api/backend/assignments');
}

export function closeAssignment(teamId: string, issueKey: string): Promise<unknown> {
  return json(
    `/api/backend/teams/${encodeURIComponent(teamId)}/assignments/${encodeURIComponent(issueKey)}/close`,
    { method: 'POST' },
  );
}

export interface IssueRow {
  issueKey: string;
  summary: string;
  assignee: string | null;
  jiraStatus: string;
  updated: string;
  reviewStatus: string;
  queuePosition?: number;
  trigger?: 'manual' | 'auto';
}

export function readIssues(): Promise<{ items: IssueRow[]; error?: string; setupRequired?: boolean }> {
  // Not `json()`: a setup error is a shape this screen has to act on rather
  // than a failure to report, so it is read rather than thrown.
  return fetch('/api/reviews').then((res) => res.json());
}

export function startReviewByKey(issueKey: string): Promise<unknown> {
  return json(`${review(issueKey)}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contextRepos: [] }),
  });
}

export function startReviewByPath(path: string): Promise<{ issueKey: string }> {
  return json<{ issueKey: string }>('/api/reviews/local', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, contextRepos: [] }),
  });
}
