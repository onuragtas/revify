import { reactive } from 'vue';

/**
 * Who is signed in, and to which team.
 *
 * The gate is deliberately soft: reviews run on this machine against this
 * machine's credentials, so a backend that cannot be reached locks nobody
 * out — a stored session gets you in, with a banner saying the team half may
 * be stale. Trading real availability for no real safety would be the wrong
 * bargain.
 */
export interface TeamUser {
  id: string;
  name: string;
  email: string;
}

export interface Team {
  id: string;
  name: string;
  role: 'owner' | 'member';
}

export const session = reactive({
  /** null until the first gate check answers. */
  ready: false as boolean,
  signedIn: false as boolean,
  /** True when the backend could not be reached and a stored session was
   * used instead. */
  offline: false as boolean,
  /** Where the build points. Named only in the offline banner — see there. */
  apiUrl: '' as string,
  production: false as boolean,
  configured: false as boolean,
  user: null as TeamUser | null,
  error: '' as string,
});

export const teams = reactive({ items: [] as Team[], currentId: null as string | null });

async function post(url: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}

/** Long enough for the server's own backend call, short enough that the
 * screen never sits blank wondering. */
const GATE_TIMEOUT_MS = 12000;

/** The gate: is there a usable session, and is the server reachable. */
export async function checkGate(): Promise<void> {
  let info: Record<string, unknown>;
  try {
    // Bounded on this side too. The server's own call is bounded, but a
    // screen that renders nothing until an answer arrives must not depend on
    // somebody else's timeout being shorter than a person's patience.
    info = await (await fetch('/api/gate', { signal: AbortSignal.timeout(GATE_TIMEOUT_MS) })).json();
  } catch (err) {
    session.error = `Uygulama sunucusuna ulaşılamadı: ${(err as Error).message}`;
    session.ready = true;
    session.signedIn = false;
    return;
  }

  session.apiUrl = String(info.apiUrl ?? '');
  session.production = Boolean(info.production);
  session.offline = Boolean(info.offline);
  session.user = (info.user as TeamUser | null) ?? null;
  session.signedIn = info.state === 'ready';
  session.error = session.signedIn ? '' : String(info.error ?? '');
  session.ready = true;
}

/** Name, email and whether there is a backend at all. Cheap enough to call
 * whenever a screen that shows team facts opens. */
export async function loadIdentity(): Promise<void> {
  try {
    const data = await (await fetch('/api/backend/me')).json();
    session.configured = Boolean(data.configured);
    session.user = data.user ?? null;
    if (data.apiUrl) session.apiUrl = data.apiUrl;
  } catch {
    session.configured = false;
    session.user = null;
  }
}

export async function loadTeams(): Promise<Team[]> {
  try {
    teams.items = (await (await fetch('/api/backend/teams')).json()).items ?? [];
  } catch {
    teams.items = [];
  }
  return teams.items;
}

export async function signIn(
  mode: 'login' | 'register',
  input: { name: string; email: string; password: string },
): Promise<string> {
  const data = await post(`/api/backend/${mode}`, input);
  if (data.error) return String(data.error);
  await checkGate();
  return '';
}

export async function signOut(): Promise<void> {
  await post('/api/backend/logout').catch(() => ({}));
  session.signedIn = false;
  session.user = null;
}
