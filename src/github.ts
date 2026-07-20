import type { BuildInput } from './types';

export interface GitHubConfig {
  owner: string;
  repo: string;
  token: string;
  workflowFile: string; // e.g. 'build.yml'
  ref: string;          // e.g. 'main'
  apiBase?: string;     // default https://api.github.com
}

export interface WorkflowRun {
  id: number;
  name: string | null;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
}
export interface RunJob { name: string; status: string; conclusion: string | null; }
export interface RunArtifact { id: number; name: string; expired: boolean; }

/**
 * Thin wrapper over the GitHub Actions REST API. All auth is a Bearer token
 * (fine-grained PAT or GitHub App installation token). Nothing here builds
 * anything locally — GitHub's runners do the work.
 */
export class GitHub {
  private base: string;
  constructor(private cfg: GitHubConfig) {
    this.base = (cfg.apiBase ?? 'https://api.github.com').replace(/\/$/, '');
  }

  private headers(extra: Record<string, string> = {}) {
    return {
      Authorization: `Bearer ${this.cfg.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'pake-cloud-builder',
      ...extra,
    };
  }
  private repoPath() {
    return `${this.base}/repos/${this.cfg.owner}/${this.cfg.repo}`;
  }

  /** Trigger the workflow. Returns 204 with no run id — correlation happens in findRun(). */
  async dispatch(buildId: string, input: BuildInput): Promise<void> {
    const url = `${this.repoPath()}/actions/workflows/${encodeURIComponent(this.cfg.workflowFile)}/dispatches`;
    const inputs: Record<string, string> = {
      url: input.url,
      name: input.name,
      icon: input.icon ?? '',
      width: String(input.width),
      height: String(input.height),
      platforms: input.platforms.join(','),
      build_id: buildId,
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ ref: this.cfg.ref, inputs }),
    });
    if (res.status !== 204) {
      throw new Error(`Dispatch failed (${res.status}): ${await safeText(res)}`);
    }
  }

  /** Find the run whose name is "build <buildId>" (set via run-name in the workflow). */
  async findRun(buildId: string, sinceMs: number): Promise<WorkflowRun | null> {
    const url = `${this.repoPath()}/actions/runs?event=workflow_dispatch&per_page=50`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`List runs failed (${res.status}): ${await safeText(res)}`);
    const data = (await res.json()) as { workflow_runs: WorkflowRun[] };
    const wanted = `build ${buildId}`;
    const buffer = 60_000;
    const matches = (data.workflow_runs ?? []).filter(
      (r) => r.name === wanted && new Date(r.created_at).getTime() >= sinceMs - buffer,
    );
    matches.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return matches[0] ?? null;
  }

  async getRun(runId: number): Promise<WorkflowRun> {
    const res = await fetch(`${this.repoPath()}/actions/runs/${runId}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Get run failed (${res.status}): ${await safeText(res)}`);
    return (await res.json()) as WorkflowRun;
  }

  async listJobs(runId: number): Promise<RunJob[]> {
    const res = await fetch(`${this.repoPath()}/actions/runs/${runId}/jobs?per_page=50`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`List jobs failed (${res.status}): ${await safeText(res)}`);
    const data = (await res.json()) as { jobs: RunJob[] };
    return data.jobs ?? [];
  }

  async listArtifacts(runId: number): Promise<RunArtifact[]> {
    const res = await fetch(`${this.repoPath()}/actions/runs/${runId}/artifacts?per_page=50`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`List artifacts failed (${res.status}): ${await safeText(res)}`);
    const data = (await res.json()) as { artifacts: RunArtifact[] };
    return data.artifacts ?? [];
  }

  /**
   * Download an artifact as a zip. GitHub returns a 302 to a signed blob URL;
   * we follow it manually so the Bearer token is never sent to blob storage.
   */
  async downloadArtifact(artifactId: number): Promise<Uint8Array> {
    const url = `${this.repoPath()}/actions/artifacts/${artifactId}/zip`;
    const first = await fetch(url, { headers: this.headers(), redirect: 'manual' });
    let res = first;
    if ([301, 302, 303, 307, 308].includes(first.status)) {
      const loc = first.headers.get('location');
      if (!loc) throw new Error('Artifact redirect missing Location header');
      res = await fetch(loc); // signed URL — no auth header
    }
    if (!res.ok) throw new Error(`Download artifact failed (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '<no body>';
  }
}
