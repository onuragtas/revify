import { backendUrl } from '../core/backendUrl.js';
import type { SettingsStore } from '../core/settingsStore.js';

export interface BackendUser {
  id: string;
  email: string;
  name: string;
}

export class BackendError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'BackendError';
  }
}

/**
 * Talks to the auto-reviewer backend on behalf of this machine's user.
 *
 * The backend coordinates people — accounts, teams, and who owes whom a
 * review. It is not where reviews run: those stay here, against this
 * machine's own credentials.
 *
 * The session token is held here — in the local settings file — rather than
 * as a browser cookie, for two reasons. A cookie scoped to `localhost:4321`
 * is readable by anything else the user happens to run on localhost, and
 * the page would otherwise have to reach a second origin, which means CORS
 * and a second place for the session to live. This way the page only ever
 * talks to its own server, and the session sits in a 0600 file.
 */
export interface TeamDecision {
  issueKey: string;
  decision: 'approved' | 'rejected';
  severity?: string;
  summary?: string;
  note?: string;
  decidedAt?: string;
  decidedByName?: string;
}

export interface TeamNudge {
  id: string;
  teamId?: string;
  issueKey: string;
  message?: string;
  createdAt: string;
  fromName?: string;
}

/** Long enough for a slow link, short enough that nobody stares at a blank
 * screen wondering whether the app is broken. */
const REQUEST_TIMEOUT_MS = 8000;

export class BackendClient {
  constructor(private readonly settings: SettingsStore) {}

  /** Always true now that the address ships with the build — kept as a
   * named concept because "is there a backend to talk to" is still the
   * question every caller is really asking. */
  get configured(): boolean {
    return Boolean(backendUrl());
  }

  /** Read per request, not cached: changing the address in settings takes
   * effect on the next call instead of the next restart. */
  private baseUrl(): string {
    return backendUrl(this.settings.get('apiUrl'));
  }

  private async request<T>(
    path: string,
    init: RequestInit & { anonymous?: boolean } = {},
  ): Promise<{ data: T; sessionToken?: string }> {
    const token = this.settings.get('apiSessionToken');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    };
    if (token && !init.anonymous) headers.Cookie = `ar_session=${token}`;

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl()}${path}`, {
        ...init,
        headers,
        redirect: 'manual',
        /*
         * A team call must not be able to hang the app.
         *
         * Everything this client does is a nicety layered over work that runs
         * locally — the reviews themselves need none of it. Without a bound,
         * an address that accepts a connection and then says nothing (a
         * firewall, a wedged proxy, a machine that went to sleep) leaves the
         * sign-in check awaiting forever, and the screen waiting on it stays
         * blank. Failing fast lands in the offline path, which is the one
         * this design already promises.
         */
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // A dead or wrong address is the most likely failure by far, and the
      // raw fetch error ("fetch failed") says nothing useful.
      throw new BackendError(
        `Sunucuya ulaşılamadı (${this.baseUrl()}): ${err instanceof Error ? err.message : String(err)}`,
        502,
      );
    }

    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new BackendError(body.error ?? `Sunucu hatası (${res.status})`, res.status);

    return { data: body as T, sessionToken: readSessionCookie(res) };
  }

  async register(email: string, name: string, password: string): Promise<BackendUser> {
    const { data, sessionToken } = await this.request<{ user: BackendUser }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, name, password }),
      anonymous: true,
    });
    this.settings.update({ apiSessionToken: sessionToken ?? '' });
    return data.user;
  }

  async login(email: string, password: string): Promise<BackendUser> {
    const { data, sessionToken } = await this.request<{ user: BackendUser }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
      anonymous: true,
    });
    this.settings.update({ apiSessionToken: sessionToken ?? '' });
    return data.user;
  }

  async logout(): Promise<void> {
    try {
      await this.request('/api/auth/logout', { method: 'POST' });
    } finally {
      // Dropped locally even if the call failed: a session this machine
      // cannot reach is not one it should keep offering.
      this.settings.update({ apiSessionToken: '' });
    }
  }

  async me(): Promise<BackendUser | null> {
    const { data } = await this.request<{ user: BackendUser | null }>('/api/auth/me');
    return data.user;
  }

  async teams(): Promise<Array<{ id: string; name: string; role: string }>> {
    const { data } = await this.request<{ items: Array<{ id: string; name: string; role: string }> }>('/api/teams/');
    return data.items;
  }

  async createTeam(name: string) {
    const { data } = await this.request<{ team: { id: string; name: string; role: string } }>('/api/teams/', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    return data.team;
  }

  async members(teamId: string) {
    const { data } = await this.request<{ items: Array<BackendUser & { role: string }> }>(
      `/api/teams/${encodeURIComponent(teamId)}/members`,
    );
    return data.items;
  }

  /** Finds people to add to a team. The backend requires a query and caps
   * the results, so this answers "who is Esma" rather than "list everyone". */
  async searchUsers(query: string) {
    const { data } = await this.request<{ items: Array<BackendUser & { role?: string }> }>(
      `/api/users?q=${encodeURIComponent(query)}`,
    );
    return data.items;
  }

  async addMember(teamId: string, userId: string) {
    const { data } = await this.request<{ member: BackendUser & { role: string } }>(
      `/api/teams/${encodeURIComponent(teamId)}/members`,
      { method: 'POST', body: JSON.stringify({ userId }) },
    );
    return data.member;
  }

  async teamSettings(teamId: string) {
    const { data } = await this.request<{ settings: Record<string, unknown>; role: string }>(
      `/api/teams/${encodeURIComponent(teamId)}/settings`,
    );
    return data;
  }

  async saveTeamSettings(teamId: string, settings: Record<string, unknown>) {
    const { data } = await this.request<{ settings: Record<string, unknown> }>(
      `/api/teams/${encodeURIComponent(teamId)}/settings`,
      { method: 'PUT', body: JSON.stringify(settings) },
    );
    return data.settings;
  }

  /** Where reviews landed, for the whole team. */
  async decisions(teamId: string): Promise<TeamDecision[]> {
    const { data } = await this.request<{ items: TeamDecision[] }>(
      `/api/teams/${encodeURIComponent(teamId)}/decisions`,
    );
    return data.items ?? [];
  }

  /** Publishes a decision that has already reached Jira. */
  async recordDecision(teamId: string, decision: Omit<TeamDecision, 'decidedAt' | 'decidedByName'>) {
    await this.request(`/api/teams/${encodeURIComponent(teamId)}/decisions`, {
      method: 'POST',
      body: JSON.stringify(decision),
    });
  }

  /** Reminders someone sent you, newer than the mark you last saw. */
  async nudges(since: string | null): Promise<TeamNudge[]> {
    const query = since ? `?since=${encodeURIComponent(since)}` : '';
    const { data } = await this.request<{ items: TeamNudge[] }>(`/api/nudges/mine${query}`);
    return data.items ?? [];
  }

  /** "Bu işe bakar mısın." */
  async nudge(teamId: string, issueKey: string, toUserId: string, message: string) {
    await this.request(
      `/api/teams/${encodeURIComponent(teamId)}/assignments/${encodeURIComponent(issueKey)}/nudge`,
      { method: 'POST', body: JSON.stringify({ toUserId, message }) },
    );
  }

  /** Who has already asked about this issue, and when. */
  async nudgesForIssue(teamId: string, issueKey: string): Promise<TeamNudge[]> {
    const { data } = await this.request<{ items: TeamNudge[] }>(
      `/api/teams/${encodeURIComponent(teamId)}/assignments/${encodeURIComponent(issueKey)}/nudges`,
    );
    return data.items ?? [];
  }

  async teamNotes(teamId: string) {
    const { data } = await this.request<{ items: Array<Record<string, unknown>> }>(
      `/api/teams/${encodeURIComponent(teamId)}/notes`,
    );
    return data.items;
  }

  async addTeamNote(teamId: string, note: { scope: string; projectPath?: string; text: string }) {
    const { data } = await this.request<{ note: Record<string, unknown> }>(
      `/api/teams/${encodeURIComponent(teamId)}/notes`,
      { method: 'POST', body: JSON.stringify(note) },
    );
    return data.note;
  }

  async deleteTeamNote(teamId: string, noteId: string) {
    await this.request(`/api/teams/${encodeURIComponent(teamId)}/notes/${encodeURIComponent(noteId)}`, {
      method: 'DELETE',
    });
  }

  async assign(teamId: string, input: { issueKey: string; assigneeId: string; note?: string; summary?: string }) {
    await this.request(`/api/teams/${encodeURIComponent(teamId)}/assignments`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async myAssignments() {
    const { data } = await this.request<{ items: Array<Record<string, unknown>> }>('/api/assignments/mine');
    return data.items;
  }

  async teamAssignments(teamId: string) {
    const { data } = await this.request<{ items: Array<Record<string, unknown>> }>(
      `/api/teams/${encodeURIComponent(teamId)}/assignments`,
    );
    return data.items;
  }

  async closeAssignment(teamId: string, issueKey: string) {
    await this.request(
      `/api/teams/${encodeURIComponent(teamId)}/assignments/${encodeURIComponent(issueKey)}/close`,
      { method: 'POST' },
    );
  }
}

/** Pulls the session cookie out of a response. Exported for tests — cookie
 * parsing is exactly the kind of thing that looks obvious and is not. */
export function readSessionCookie(res: Response): string | undefined {
  const raw = res.headers.getSetCookie?.() ?? [];
  for (const cookie of raw) {
    const match = cookie.match(/^ar_session=([^;]*)/);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return undefined;
}
