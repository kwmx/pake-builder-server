import type { BuildInput } from './types';

export interface GitHubConfig {
  owner: string;
  repo: string;
  token: string;
  workflowFile: string;
  ref: string;
  apiBase?: string;
}

export interface WorkflowRun {
  id: number;
  name: string | null;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
}
export interface RunJob {
  name: string;
  status: string;
  conclusion: string | null;
}
export interface RunArtifact {
  id: number;
  name: string;
  expired: boolean;
}

/** A run created within this window of the dispatch still counts as ours. */
const CLOCK_SKEW_MS = 60_000;

/**
 * Calls the GitHub Actions REST API. Nothing is compiled here — this only
 * starts runs on GitHub's runners and retrieves what they produced.
 */
export class GitHub {
  private base: string;

  constructor(private config: GitHubConfig) {
    this.base = (config.apiBase ?? 'https://api.github.com').replace(/\/$/, '');
  }

  private headers(extra: Record<string, string> = {}) {
    return {
      Authorization: `Bearer ${this.config.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'pake-cloud-builder',
      ...extra,
    };
  }

  private repoPath(): string {
    return `${this.base}/repos/${this.config.owner}/${this.config.repo}`;
  }

  private async getJson<T>(url: string, label: string): Promise<T> {
    const response = await fetch(url, { headers: this.headers() });
    if (!response.ok) throw await describeFailure(response, label);
    return (await response.json()) as T;
  }

  /** Starts the workflow. GitHub answers 204 with no body, hence findRun(). */
  async dispatch(buildId: string, input: BuildInput): Promise<void> {
    const url = `${this.repoPath()}/actions/workflows/${encodeURIComponent(this.config.workflowFile)}/dispatches`;
    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        ref: this.config.ref,
        inputs: {
          url: input.url,
          name: input.name,
          icon: input.icon ?? '',
          width: String(input.width),
          height: String(input.height),
          platforms: input.platforms.join(','),
          build_id: buildId,
        },
      }),
    });
    if (response.status !== 204) throw await describeFailure(response, 'Dispatch');
  }

  /** Match the run by the build id the workflow echoes into its run-name. */
  async findRun(buildId: string, dispatchedAt: number): Promise<WorkflowRun | null> {
    const page = await this.getJson<{ workflow_runs: WorkflowRun[] }>(
      `${this.repoPath()}/actions/runs?event=workflow_dispatch&per_page=50`,
      'List runs',
    );
    const expectedName = `build ${buildId}`;
    return (
      (page.workflow_runs ?? [])
        .filter(
          (run) =>
            run.name === expectedName &&
            new Date(run.created_at).getTime() >= dispatchedAt - CLOCK_SKEW_MS,
        )
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0] ??
      null
    );
  }

  async getRun(runId: number): Promise<WorkflowRun> {
    return this.getJson<WorkflowRun>(`${this.repoPath()}/actions/runs/${runId}`, 'Get run');
  }

  async listJobs(runId: number): Promise<RunJob[]> {
    const page = await this.getJson<{ jobs: RunJob[] }>(
      `${this.repoPath()}/actions/runs/${runId}/jobs?per_page=50`,
      'List run jobs',
    );
    return page.jobs ?? [];
  }

  async listArtifacts(runId: number): Promise<RunArtifact[]> {
    const page = await this.getJson<{ artifacts: RunArtifact[] }>(
      `${this.repoPath()}/actions/runs/${runId}/artifacts?per_page=50`,
      'List artifacts',
    );
    return page.artifacts ?? [];
  }

  /**
   * Artifacts come back as a zip behind a 302 to blob storage. The redirect is
   * followed by hand so the Authorization header is never sent off-origin.
   */
  async downloadArtifact(artifactId: number): Promise<Uint8Array> {
    const initial = await fetch(`${this.repoPath()}/actions/artifacts/${artifactId}/zip`, {
      headers: this.headers(),
      redirect: 'manual',
    });

    let download = initial;
    if ([301, 302, 303, 307, 308].includes(initial.status)) {
      const signedUrl = initial.headers.get('location');
      if (!signedUrl) throw new Error('Artifact download redirect had no Location header.');
      download = await fetch(signedUrl);
    }
    if (!download.ok) throw await describeFailure(download, 'Download artifact');
    return new Uint8Array(await download.arrayBuffer());
  }
}

/** Turn an HTTP failure into something a user can act on, not just a status code. */
async function describeFailure(response: Response, label: string): Promise<Error> {
  const remaining = response.headers.get('x-ratelimit-remaining');
  if ((response.status === 403 || response.status === 429) && remaining === '0') {
    const resetAt = Number(response.headers.get('x-ratelimit-reset') ?? 0) * 1000;
    const minutes = Math.max(1, Math.ceil((resetAt - Date.now()) / 60_000));
    return new Error(`GitHub API rate limit reached. It resets in about ${minutes} min.`);
  }
  if (response.status === 401) {
    return new Error(`${label} rejected the token (401). Check GITHUB_TOKEN.`);
  }
  if (response.status === 404) {
    return new Error(
      `${label} returned 404. GitHub reports 404 for repositories a token cannot see, so verify GITHUB_OWNER, GITHUB_REPO and the token's repository access.`,
    );
  }

  let detail = '';
  try {
    detail = (await response.text()).slice(0, 300);
  } catch {
    detail = '<no body>';
  }
  return new Error(`${label} failed (${response.status}): ${detail}`);
}
