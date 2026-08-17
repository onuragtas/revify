export interface GitlabClientOptions {
  baseUrl: string;
  token: string;
}

export interface DiffFile {
  path: string;
  /** Unified-diff body for this file (the `@@ … @@` hunks). */
  diff: string;
}

export interface BranchDiff {
  baseBranch: string;
  branchName: string;
  /** Flattened text used for the AI prompt. */
  diff: string;
  /** Same content kept per file, so the UI can render a side-by-side view
   * without having to re-split the flattened blob. */
  files: DiffFile[];
}

/** Pure so it's testable without mocking HTTP. Accepts a GitLab repository
 * URL as returned by Jira's dev-status API (e.g.
 * `https://gitlab.com/group/subgroup/project` or `.../project.git`) and
 * returns the `group/.../project` path GitLab's API expects as :id. */
export function parseProjectPathFromUrl(url: string): string | null {
  const match = url.match(/^https?:\/\/[^/]+\/(.+?)(?:\.git)?\/?$/);
  if (!match) return null;
  return match[1];
}

export interface GitlabProject {
  projectPath: string;
  name: string;
  defaultBranch: string;
}

export class GitlabClient {
  constructor(private readonly options: GitlabClientOptions) {}

  private async request<T>(path: string): Promise<T> {
    const url = `${this.options.baseUrl.replace(/\/$/, '')}/api/v4${path}`;
    const res = await fetch(url, { headers: { 'PRIVATE-TOKEN': this.options.token } });
    if (!res.ok) {
      throw new Error(`GitLab API ${res.status} ${res.statusText} for ${url}: ${await res.text()}`);
    }
    return (await res.json()) as T;
  }

  /** Every project this token can read, so the reviewer can pick which
   * ones are relevant context for a change instead of us guessing or
   * cloning all of them. Paginated — GitLab caps per_page at 100. */
  async listProjects(): Promise<GitlabProject[]> {
    const projects: GitlabProject[] = [];
    for (let page = 1; page <= 20; page++) {
      const batch = await this.request<
        Array<{ path_with_namespace: string; name: string; default_branch?: string }>
      >(`/projects?membership=true&simple=true&per_page=100&order_by=last_activity_at&page=${page}`);
      for (const p of batch) {
        projects.push({
          projectPath: p.path_with_namespace,
          name: p.name,
          defaultBranch: p.default_branch ?? 'main',
        });
      }
      if (batch.length < 100) break;
    }
    return projects;
  }

  async getDefaultBranch(projectPath: string): Promise<string> {
    const projectId = encodeURIComponent(projectPath);
    const project = await this.request<{ default_branch: string }>(`/projects/${projectId}`);
    return project.default_branch;
  }

  /** Diffs `branchName` against `baseBranch` (typically the repo's default
   * branch) via GitLab's compare endpoint — no merge request required. */
  async compareBranches(projectPath: string, baseBranch: string, branchName: string): Promise<BranchDiff> {
    const projectId = encodeURIComponent(projectPath);
    const params = new URLSearchParams({ from: baseBranch, to: branchName });
    const compare = await this.request<{ diffs: Array<{ new_path: string; diff: string }> }>(
      `/projects/${projectId}/repository/compare?${params.toString()}`,
    );
    const files: DiffFile[] = compare.diffs.map((d) => ({ path: d.new_path, diff: d.diff }));
    const diff = files.map((f) => `--- ${f.path} ---\n${f.diff}`).join('\n\n');
    return { baseBranch, branchName, diff, files };
  }
}
