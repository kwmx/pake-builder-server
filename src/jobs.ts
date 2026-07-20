import { mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { nanoid } from 'nanoid';
import { GitHub } from './github';
import type { BuildInput, Job } from './types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const OSES = ['linux', 'windows', 'macos'] as const;

/**
 * Owns the lifecycle of every build: create → dispatch → locate run → poll →
 * collect artifacts → extract to disk. GitHub does the compilation; this just
 * drives it and serves the results.
 */
export class JobStore {
  private jobs = new Map<string, Job>();
  private queue: string[] = [];
  private active = 0;

  constructor(
    private gh: GitHub,
    private buildDir: string,
    private maxActive = 8,
  ) {}

  create(input: BuildInput): Job {
    const job: Job = {
      id: nanoid(12),
      buildId: nanoid(16),
      input,
      status: 'queued',
      legs: [],
      artifacts: [],
      log: [],
      createdAt: Date.now(),
    };
    this.jobs.set(job.id, job);
    this.queue.push(job.id);
    this.pump();
    return job;
  }

  get(id: string) {
    return this.jobs.get(id);
  }
  list() {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  private pump() {
    while (this.active < this.maxActive && this.queue.length) {
      const id = this.queue.shift()!;
      const job = this.jobs.get(id);
      if (job) void this.run(job);
    }
  }

  private jobDir(job: Job) {
    return path.join(this.buildDir, job.id);
  }

  private async run(job: Job) {
    this.active++;
    try {
      await this.orchestrate(job);
    } catch (e) {
      job.status = 'error';
      job.error = e instanceof Error ? e.message : String(e);
      job.log.push(`\u2715 ${job.error}`);
    } finally {
      job.finishedAt = Date.now();
      this.active--;
      this.pump();
    }
  }

  private async orchestrate(job: Job) {
    const log = (m: string) => job.log.push(m);

    // 1) Dispatch
    job.status = 'dispatching';
    const dispatchedAt = Date.now();
    log(`\u2192 Dispatching workflow for ${job.input.platforms.join(', ')} \u2026`);
    await this.gh.dispatch(job.buildId, job.input);
    log('\u2713 Dispatched. Locating the workflow run\u2026');

    // 2) Locate the run (it can take a few seconds to register)
    job.status = 'locating';
    let runId: number | undefined;
    for (let i = 0; i < 30 && runId === undefined; i++) {
      await sleep(i === 0 ? 3000 : 4000);
      const run = await this.gh.findRun(job.buildId, dispatchedAt);
      if (run) {
        runId = run.id;
        job.runId = run.id;
        job.runUrl = run.html_url;
        log(`\u2713 Run found \u2192 ${run.html_url}`);
      }
    }
    if (runId === undefined) {
      throw new Error('Timed out waiting for the workflow run to appear (check the token scopes and that build.yml is on the default branch).');
    }

    // 3) Poll until complete, refreshing per-platform leg status as we go
    job.status = 'running';
    let conclusion: string | null = null;
    const deadline = Date.now() + 40 * 60 * 1000;
    while (Date.now() < deadline) {
      await sleep(6000);
      const run = await this.gh.getRun(runId);
      job.legs = await this.legStatuses(runId);
      if (run.status === 'completed') {
        conclusion = run.conclusion;
        break;
      }
    }
    if (conclusion === null) throw new Error('Timed out waiting for the run to finish.');
    log(`\u2713 Run completed: ${conclusion}`);

    // 4) Collect artifacts (partial success is fine — some platforms may fail)
    job.status = 'collecting';
    const artifacts = await this.gh.listArtifacts(runId);
    if (!artifacts.length) {
      throw new Error(`Run concluded "${conclusion}" but produced no artifacts.`);
    }
    for (const art of artifacts) {
      if (art.expired) continue;
      const os = osFromArtifact(art.name);
      log(`\u2193 Downloading ${art.name}\u2026`);
      const zip = await this.gh.downloadArtifact(art.id);
      const files = unzipSync(zip);
      const outDir = path.join(this.jobDir(job), os);
      await mkdir(outDir, { recursive: true });
      for (const [entry, bytes] of Object.entries(files)) {
        if (entry.endsWith('/') || bytes.length === 0) continue;
        const dest = path.join(outDir, entry);
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(dest, bytes);
        job.artifacts.push({ os, file: `${os}/${entry}`, name: path.basename(entry), size: bytes.length });
      }
    }
    if (!job.artifacts.length) throw new Error('Artifacts downloaded but contained no files.');

    // Downloads exist regardless of overall conclusion; warn on partial failure.
    job.status = 'done';
    if (conclusion !== 'success') {
      job.warning = `Run concluded "${conclusion}" — some platforms may have failed. The downloads below are the ones that succeeded.`;
      log(`\u26a0 ${job.warning}`);
    }
    log('\u2713 Done.');
  }

  private async legStatuses(runId: number) {
    const jobs = await this.gh.listJobs(runId);
    return jobs
      .filter((j) => j.name !== 'setup')
      .map((j) => ({ os: osFromLeg(j.name), status: j.status, conclusion: j.conclusion }));
  }

  /** Resolve a validated artifact path to an absolute file, or null. */
  async fileFor(job: Job, rel: string): Promise<string | null> {
    if (!job.artifacts.some((a) => a.file === rel)) return null; // whitelist guards traversal
    const full = path.join(this.jobDir(job), rel);
    try {
      await stat(full);
      return full;
    } catch {
      return null;
    }
  }
}

function osFromArtifact(name: string): string {
  for (const p of OSES) if (name.endsWith(`-${p}`)) return p;
  return 'unknown';
}
function osFromLeg(name: string): string {
  const m = name.match(/\((linux|windows|macos)\)/);
  return m ? m[1] : name;
}
