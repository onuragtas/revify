import { markdownToAdf, adfToText } from './adf.js';

export interface JiraIssueSummary {
  id: string;
  key: string;
  fields: {
    summary: string;
    status: { name: string };
    assignee?: { displayName?: string; accountId?: string } | null;
    updated?: string;
  };
}

export interface JiraIssueDetail extends JiraIssueSummary {
  fields: JiraIssueSummary['fields'] & { description?: unknown };
}

export interface JiraLinkedBranch {
  name: string;
  repositoryUrl: string;
}

export interface JiraClientOptions {
  baseUrl: string;
  email: string;
  apiToken: string;
}

const SEARCH_FIELDS = ['summary', 'status', 'description', 'assignee', 'updated', 'issuetype', 'priority'];

export interface JiraAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  contentUrl: string;
  created: string;
}

export interface JiraComment {
  author: string;
  created: string;
  text: string;
}

export interface JiraRelatedIssue {
  key: string;
  /** How it relates: 'parent', 'subtask', or the Jira link phrase. */
  relation: string;
  issueType: string | null;
  status: string | null;
  summary: string;
  description: string;
}

export interface JiraChangelogEntry {
  created: string;
  items: Array<{
    field: string;
    from?: string | null;
    fromString?: string | null;
    to?: string | null;
    toString?: string | null;
  }>;
}

export interface JiraIssueMeta {
  key: string;
  summary: string;
  status: string;
  description: unknown;
  assignee: string | null;
  assigneeAccountId: string | null;
  reporter: string | null;
  issueType: string | null;
  priority: string | null;
  sprint: string | null;
  updated: string | null;
}

/** Pure so it's testable without mocking HTTP.
 * `/rest/api/3/search` was removed by Atlassian (410 Gone) in favor of
 * `/rest/api/3/search/jql` — same query params, same response shape for a
 * single page (`issues[]`); pagination uses `nextPageToken` instead of
 * `startAt`, which this MVP doesn't paginate through (same as before). */
export function buildSearchUrl(baseUrl: string, jql: string, fields: string[] = SEARCH_FIELDS): string {
  const params = new URLSearchParams({ jql, fields: fields.join(',') });
  return `${baseUrl.replace(/\/$/, '')}/rest/api/3/search/jql?${params.toString()}`;
}

export class JiraClient {
  constructor(private readonly options: JiraClientOptions) {}

  private authHeader(): string {
    const token = Buffer.from(`${this.options.email}:${this.options.apiToken}`).toString('base64');
    return `Basic ${token}`;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.options.baseUrl.replace(/\/$/, '')}${path}`;
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: this.authHeader(),
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...init.headers,
      },
    });
    if (!res.ok) {
      throw new Error(`Jira API ${res.status} ${res.statusText} for ${url}: ${await res.text()}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async searchIssues(jql: string): Promise<JiraIssueSummary[]> {
    const url = buildSearchUrl(this.options.baseUrl, jql);
    const data = await this.request<{ issues: JiraIssueSummary[] }>(url);
    return data.issues;
  }

  /** Sprint lives in a per-instance custom field, so its id is discovered
   * from the field catalogue rather than hardcoded — a hardcoded
   * `customfield_10020` would silently return nothing on another Jira. */
  private sprintFieldId?: string | null;
  private async getSprintFieldId(): Promise<string | null> {
    if (this.sprintFieldId !== undefined) return this.sprintFieldId;
    try {
      const fields = await this.request<Array<{ id: string; name: string; schema?: { custom?: string } }>>(
        '/rest/api/3/field',
      );
      const sprint = fields.find(
        (f) => f.schema?.custom?.includes('gh-sprint') || f.name.toLowerCase() === 'sprint',
      );
      this.sprintFieldId = sprint?.id ?? null;
    } catch {
      this.sprintFieldId = null;
    }
    return this.sprintFieldId;
  }

  /** The human-facing view of an issue: who owns it, which sprint, when it
   * last moved — the context a reviewer wants before reading a diff. */
  async getIssueMeta(issueKey: string): Promise<JiraIssueMeta> {
    const sprintField = await this.getSprintFieldId();
    const fields = [...SEARCH_FIELDS, 'reporter', ...(sprintField ? [sprintField] : [])];
    const issue = await this.request<{
      key: string;
      fields: Record<string, any>;
    }>(`/rest/api/3/issue/${issueKey}?fields=${fields.join(',')}`);

    const sprints = sprintField ? issue.fields[sprintField] : null;
    return {
      key: issue.key,
      summary: issue.fields.summary,
      status: issue.fields.status?.name ?? '',
      description: issue.fields.description,
      assignee: issue.fields.assignee?.displayName ?? null,
      assigneeAccountId: issue.fields.assignee?.accountId ?? null,
      reporter: issue.fields.reporter?.displayName ?? null,
      issueType: issue.fields.issuetype?.name ?? null,
      priority: issue.fields.priority?.name ?? null,
      // A ticket can carry several sprints; the last one is the current one.
      sprint: Array.isArray(sprints) && sprints.length ? (sprints[sprints.length - 1]?.name ?? null) : null,
      updated: issue.fields.updated ?? null,
    };
  }

  async getIssue(issueKey: string): Promise<JiraIssueDetail> {
    return this.request<JiraIssueDetail>(`/rest/api/3/issue/${issueKey}?fields=${SEARCH_FIELDS.join(',')}`);
  }

  /** Reads the issue's "development panel" data to find linked GitLab
   * branches (no merge request required — just a pushed branch whose name
   * Jira's GitLab integration associated with this issue). Note: the
   * dev-status endpoint is the same one Jira's own UI uses internally and
   * isn't part of Atlassian's officially documented REST API — this shape
   * is the commonly observed one; verify against your instance if it
   * doesn't match.
   *
   * `applicationType` is required by `/issue/detail` but isn't a fixed
   * string — it's whichever GitLab integration app is installed on this
   * Jira site (e.g. `oAuth-gitlab-jira-connect-gitlab.com` for a
   * self-hosted GitLab via the GitLab.com Jira Connect app), so we look it
   * up dynamically via `/issue/summary` first instead of guessing it. */
  async getLinkedBranches(issueId: string): Promise<JiraLinkedBranch[]> {
    /*
     * A tripwire, because this one fails quietly at the wrong end.
     *
     * Without it a missing id is interpolated into the URL as the string
     * "undefined" and Jira answers 400 "An invalid ID was provided" — an
     * error that names Jira and says nothing about the caller that had no
     * id to give. Callers with a legitimately id-less event (a review of a
     * local directory) skip this entirely; anyone reaching here without one
     * has a bug worth seeing.
     */
    if (!issueId) throw new Error('getLinkedBranches: issueId gerekli (dev-status yalnızca id ile sorgulanır).');
    const summary = await this.request<{
      summary?: { branch?: { overall?: { count?: number }; byInstanceType?: Record<string, unknown> } };
    }>(`/rest/dev-status/1.0/issue/summary?issueId=${issueId}`);

    const branchSummary = summary.summary?.branch;
    if (!branchSummary || (branchSummary.overall?.count ?? 0) === 0) {
      return [];
    }

    const applicationTypes = Object.keys(branchSummary.byInstanceType ?? {});
    const branches: JiraLinkedBranch[] = [];
    for (const applicationType of applicationTypes) {
      const data = await this.request<{
        detail?: Array<{ branches?: Array<{ name: string; repository?: { url?: string } }> }>;
      }>(
        `/rest/dev-status/1.0/issue/detail?issueId=${issueId}&applicationType=${encodeURIComponent(applicationType)}&dataType=branch`,
      );
      for (const d of data.detail ?? []) {
        for (const b of d.branches ?? []) {
          if (b.repository?.url) branches.push({ name: b.name, repositoryUrl: b.repository.url });
        }
      }
    }
    return branches;
  }

  /**
   * Moves an issue to a named status. Transition ids are workflow-specific
   * — the same status can be a different id in another project — so the
   * transition is resolved by the status it leads to, at call time.
   */
  async transitionTo(issueKey: string, statusName: string): Promise<void> {
    const { transitions } = await this.request<{
      transitions: Array<{ id: string; name: string; to: { name: string } }>;
    }>(`/rest/api/3/issue/${issueKey}/transitions`);

    const wanted = statusName.trim().toLowerCase();
    const match =
      transitions.find((t) => t.to.name.trim().toLowerCase() === wanted) ??
      transitions.find((t) => t.name.trim().toLowerCase() === wanted);

    if (!match) {
      const available = transitions.map((t) => t.to.name).join(', ');
      throw new Error(
        `No transition to "${statusName}" is available for ${issueKey} from its current status. Available: ${available}`,
      );
    }

    await this.request(`/rest/api/3/issue/${issueKey}/transitions`, {
      method: 'POST',
      body: JSON.stringify({ transition: { id: match.id } }),
    });
  }

  /**
   * Who had the issue before it went out for review.
   *
   * The obvious answer — "whoever it is assigned to now" — is wrong, and
   * quietly so: by the time this tool sees an issue it is already *in*
   * review, and teams that hand a ticket to a reviewer have already
   * reassigned it. Reading the current assignee therefore returns the
   * reviewer, and sending the issue back to them is a no-op nobody notices.
   *
   * So this reads the changelog instead and answers the question directly:
   * find the last transition into the review status, and take the assignee
   * that was in effect just before it.
   */
  async getPreReviewAssignee(
    issueKey: string,
    reviewStatus: string,
  ): Promise<{ accountId: string; displayName: string } | null> {
    const history = await this.fetchChangelog(issueKey);
    const wanted = reviewStatus.trim().toLowerCase();

    // Last, not first: an issue can go round the loop more than once, and
    // the relevant developer is the one from the most recent lap.
    let transitionAt: number | null = null;
    for (const entry of history) {
      const toReview = entry.items.some(
        (i) => i.field === 'status' && (i.toString ?? '').trim().toLowerCase() === wanted,
      );
      if (toReview) transitionAt = Date.parse(entry.created);
    }
    if (transitionAt === null) return null;

    // Reassigning to the reviewer and moving the status are one action by
    // intent, but two changelog entries, and they land in either order.
    // Anything inside this window counts as part of the handover, so its
    // `from` is the developer — not its `to`, which is the reviewer.
    const HANDOVER_WINDOW_MS = 2 * 60 * 1000;

    let beforeTransition: { accountId: string; displayName: string } | null = null;
    for (const entry of history) {
      const at = Date.parse(entry.created);
      for (const item of entry.items) {
        if (item.field !== 'assignee') continue;

        if (Math.abs(at - transitionAt) <= HANDOVER_WINDOW_MS) {
          // The handover itself: whoever it was taken *from*.
          return item.from ? { accountId: item.from, displayName: item.fromString ?? item.from } : null;
        }
        if (at < transitionAt && item.to) {
          beforeTransition = { accountId: item.to, displayName: item.toString ?? item.to };
        }
      }
    }
    return beforeTransition;
  }

  /** Changelog entries oldest-first, following pagination. */
  private async fetchChangelog(issueKey: string): Promise<JiraChangelogEntry[]> {
    const all: JiraChangelogEntry[] = [];
    let startAt = 0;
    // Bounded so a pathological issue can't spin here forever; 10 pages of
    // 100 is far past any real ticket's history.
    for (let page = 0; page < 10; page++) {
      const data = await this.request<{
        values: JiraChangelogEntry[];
        isLast?: boolean;
        total?: number;
      }>(`/rest/api/3/issue/${issueKey}/changelog?startAt=${startAt}&maxResults=100`);

      all.push(...(data.values ?? []));
      if (data.isLast || !data.values?.length || all.length >= (data.total ?? all.length)) break;
      startAt = all.length;
    }
    return all.sort((a, b) => Date.parse(a.created) - Date.parse(b.created));
  }

  /**
   * The issue's discussion, oldest first.
   *
   * Comments are where a team actually records what it decided: acceptance
   * criteria that never made it into the description, and the changes an
   * earlier review asked for. A review that ignores them can't tell whether
   * the work it is looking at is a response to something.
   *
   * Only the most recent `limit` are returned — a long-running ticket can
   * carry dozens, and the older ones are the least likely to still bind.
   */
  async getComments(issueKey: string, limit = 25): Promise<JiraComment[]> {
    const data = await this.request<{
      comments: Array<{
        author?: { displayName?: string };
        created?: string;
        updated?: string;
        body?: unknown;
      }>;
    }>(`/rest/api/3/issue/${issueKey}/comment?orderBy=created&maxResults=${Math.max(limit, 1)}`);

    return (data.comments ?? []).slice(-limit).map((c) => ({
      author: c.author?.displayName ?? '(unknown)',
      created: c.created ?? '',
      text: adfToText(c.body),
    }));
  }

  /**
   * The issues around this one: its parent, its subtasks, and anything
   * linked to it.
   *
   * A ticket is often written for someone who already knows the programme
   * it belongs to — "[Tedarikçi Panel] Sipariş Detayında Barcode Listing"
   * says what to build only if you know what the rollout around it is. The
   * neighbours carry that, plus the vocabulary and conventions the team has
   * already settled on elsewhere.
   *
   * Their text is capped hard: this is background for understanding the
   * work, not a second specification, and an epic pasted in full would
   * drown the issue actually under review.
   */
  async getRelatedIssues(issueKey: string, limit = 6): Promise<JiraRelatedIssue[]> {
    const issue = await this.request<{
      fields: {
        parent?: { key: string } | null;
        subtasks?: Array<{ key: string }>;
        issuelinks?: Array<{
          type?: { inward?: string; outward?: string };
          inwardIssue?: { key: string };
          outwardIssue?: { key: string };
        }>;
      };
    }>(`/rest/api/3/issue/${issueKey}?fields=parent,subtasks,issuelinks`);

    const relations = new Map<string, string>();
    const add = (key: string | undefined, relation: string) => {
      if (key && key !== issueKey && !relations.has(key)) relations.set(key, relation);
    };

    add(issue.fields.parent?.key, 'parent');
    for (const sub of issue.fields.subtasks ?? []) add(sub.key, 'subtask');
    for (const link of issue.fields.issuelinks ?? []) {
      if (link.outwardIssue) add(link.outwardIssue.key, link.type?.outward ?? 'linked');
      else if (link.inwardIssue) add(link.inwardIssue.key, link.type?.inward ?? 'linked');
    }

    const keys = [...relations.keys()].slice(0, limit);
    if (keys.length === 0) return [];

    // One search instead of a request per neighbour.
    const jql = `key in (${keys.join(',')})`;
    const url = buildSearchUrl(this.options.baseUrl, jql, [
      'summary',
      'description',
      'issuetype',
      'status',
    ]);
    const data = await this.request<{
      issues: Array<{ key: string; fields: Record<string, any> }>;
    }>(url);

    return (data.issues ?? []).map((i) => ({
      key: i.key,
      relation: relations.get(i.key) ?? 'linked',
      issueType: i.fields.issuetype?.name ?? null,
      status: i.fields.status?.name ?? null,
      summary: i.fields.summary ?? '',
      description: adfToText(i.fields.description),
    }));
  }

  /**
   * Files attached to an issue — including the ones added inside comments,
   * which Jira stores on the issue rather than the comment.
   *
   * Only the listing. Downloading is the caller's business, because what
   * is worth downloading depends on size and type, and that is a policy
   * decision rather than a Jira one.
   */
  async getAttachments(issueKey: string): Promise<JiraAttachment[]> {
    const issue = await this.request<{
      fields: {
        attachment?: Array<{
          id: string;
          filename?: string;
          mimeType?: string;
          size?: number;
          content?: string;
          created?: string;
        }>;
      };
    }>(`/rest/api/3/issue/${issueKey}?fields=attachment`);

    return (issue.fields.attachment ?? []).map((a) => ({
      id: a.id,
      filename: a.filename ?? `attachment-${a.id}`,
      mimeType: a.mimeType ?? '',
      size: a.size ?? 0,
      contentUrl: a.content ?? '',
      created: a.created ?? '',
    }));
  }

  /**
   * Downloads one attachment.
   *
   * Returns the bytes rather than writing them: where they land is the
   * caller's decision, and this client has no business knowing about the
   * directory the model is given.
   */
  async downloadAttachment(contentUrl: string): Promise<Buffer> {
    const res = await fetch(contentUrl, {
      headers: { Authorization: this.authHeader() },
      // Jira answers the content URL with a redirect to storage; the
      // Authorization header must not be replayed to another host, and
      // fetch drops it for us on a cross-origin redirect.
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`Jira attachment ${res.status} ${res.statusText}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Assigns by accountId. Passing null unassigns. */
  async assign(issueKey: string, accountId: string | null): Promise<void> {
    await this.request(`/rest/api/3/issue/${issueKey}/assignee`, {
      method: 'PUT',
      body: JSON.stringify({ accountId }),
    });
  }

  /** Jira comments are ADF, not Markdown — the review text is converted so
   * headings, code blocks and lists render instead of showing their raw
   * `###`/``` ``` ```/`-` characters in one collapsed paragraph. */
  async addComment(issueKey: string, markdownBody: string): Promise<void> {
    await this.request(`/rest/api/3/issue/${issueKey}/comment`, {
      method: 'POST',
      body: JSON.stringify({ body: markdownToAdf(markdownBody) }),
    });
  }
}
