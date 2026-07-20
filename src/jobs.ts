import { mkdir, writeFile, stat, rm, readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { nanoid } from 'nanoid';
import { GitHub, type RunJob } from './github';
import { JobDatabase } from './db';
import { readSiteMetadata } from './metadata';
import type { BuildInput, Job, JobStatus } from './types';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const PLATFORM_SUFFIXES = ['linux', 'windows', 'macos'] as const;
// Matches the platform anywhere in a job name, so this keeps working whether
// GitHub reports "build (linux)" or the default "build (linux, ubuntu-latest)".
// The setup job contains no platform token and is excluded by the same test.
const MATRIX_LEG_NAME = /\b(linux|windows|macos)\b/i;

// One list-jobs call per tick keeps a full build well inside GitHub's 5,000
// req/hour budget even at max concurrency; the run itself is only fetched once
// the legs report completion.
const DEFAULT_POLL_INTERVAL_MS = 15_000;
// Catches runs cancelled before any matrix leg was created, which leaves
// list-jobs permanently empty.
const RUN_RECHECK_EVERY = 10;
const RUN_TIMEOUT_MS = 40 * 60 * 1000;
const RUN_APPEAR_ATTEMPTS = 30;
// A run can be reported complete before its last artifact is listable, so the
// final sweep waits for the platforms that succeeded rather than taking one look.
const ARTIFACT_SETTLE_ATTEMPTS = 6;
const ARTIFACT_SETTLE_MS = 5000;

const UNFINISHED: JobStatus[] = ['queued', 'dispatching', 'locating', 'running', 'collecting'];

export interface JobStoreOptions {
  maxActive: number;
  retentionDays: number;
  /** Lower it and GitHub's rate limit arrives sooner; raise it for slower status updates. */
  pollIntervalMs?: number;
}

/**
 * Owns a build from submission to downloadable installer: dispatch to GitHub,
 * follow the run, mirror its artifacts to local disk. Every transition is
 * written through to SQLite so a redeploy neither loses history nor abandons a
 * run that is still executing on GitHub.
 */
export class JobStore {
  private jobs = new Map<string, Job>();
  private waiting: string[] = [];
  private active = 0;
  // ReturnType<> rather than NodeJS.Timeout so this typechecks without @types/node.
  private sweepTimer?: ReturnType<typeof setInterval>;
  private pollIntervalMs: number;
  private stopped = false;
  private removed = new Set<string>();
  /** jobId -> resolve fn, so a poll can be woken before its interval elapses. */
  private waiters = new Map<string, () => void>();

  constructor(
    private gh: GitHub,
    private buildDir: string,
    private db: JobDatabase,
    private options: JobStoreOptions,
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  // ---- lifecycle ----------------------------------------------------------

  /** Reload history, re-attach to runs interrupted by a restart, start the sweeper. */
  async start(): Promise<void> {
    for (const job of this.db.loadAll()) this.jobs.set(job.id, job);

    for (const job of this.jobs.values()) {
      if (!UNFINISHED.includes(job.status)) continue;

      if (job.status === 'queued') {
        // Never dispatched, so re-running it cannot double-build.
        this.waiting.push(job.id);
        continue;
      }
      // Dispatch may or may not have landed. Re-attaching by build id is safe
      // either way: the run is found and followed, or it never existed and the
      // job is marked failed. Neither path dispatches a second build.
      job.log.push('\u21ba Reconnecting after a restart\u2026');
      this.persist(job);
      void this.execute(job, { alreadyDispatched: true });
    }

    await this.sweepQuietly();
    this.sweepTimer = setInterval(() => void this.sweepQuietly(), 60 * 60 * 1000);
    this.sweepTimer.unref?.();
    this.drainQueue();
  }

  stop(): void {
    // Builds still in flight keep running until the process exits, but the
    // database is about to close, so stop writing through to it.
    this.stopped = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  // ---- queries ------------------------------------------------------------

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  // ---- submission ---------------------------------------------------------

  /**
   * The newest build for an identical spec, if one exists. Failed builds are
   * ignored so a retry never gets blocked by its own earlier failure.
   */
  findExisting(input: BuildInput): Job | undefined {
    const key = specKey(input);
    return this.list().find((job) => job.status !== 'error' && specKey(job.input) === key);
  }

  submit(input: BuildInput): Job {
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
    this.persist(job);
    this.waiting.push(job.id);
    this.drainQueue();
    return job;
  }

  private drainQueue(): void {
    while (this.active < this.options.maxActive && this.waiting.length) {
      const id = this.waiting.shift()!;
      const job = this.jobs.get(id);
      if (job) void this.execute(job, { alreadyDispatched: false });
    }
  }

  private persist(job: Job): void {
    if (this.stopped || this.removed.has(job.id)) return;
    try {
      this.db.save(job);
    } catch (err) {
      // A failed write costs history, not the build — keep going.
      console.error(`[db] could not save job ${job.id}:`, err);
    }
  }

  private jobDir(jobId: string): string {
    return path.join(this.buildDir, jobId);
  }

  // ---- the build itself ---------------------------------------------------

  private async execute(job: Job, opts: { alreadyDispatched: boolean }): Promise<void> {
    this.active++;
    try {
      if (!opts.alreadyDispatched) {
        await this.fillGapsFromSite(job);
        job.status = 'dispatching';
        // Spelled out because "the description was empty" is otherwise only
        // discoverable from the workflow's own report, minutes later.
        job.log.push(
          `\u2192 Dispatching ${job.input.platforms.join(', ')} \u2014 description: ` +
            `${job.input.description ? `${job.input.description.length} chars` : 'NONE'}, icon: ` +
            `${job.input.icon ? job.input.icon : 'NONE'}`,
        );
        this.persist(job);
        await this.gh.dispatch(job.buildId, job.input);
        job.log.push('\u2713 Dispatched. Locating the run\u2026');
      }

      const runId = job.runId ?? (await this.locateRun(job));
      const conclusion = await this.followRun(job, runId);
      await this.finishBuild(job, runId, conclusion);
    } catch (err) {
      job.status = 'error';
      job.error = err instanceof Error ? err.message : String(err);
      job.log.push(`\u2715 ${job.error}`);
    } finally {
      job.finishedAt = Date.now();
      this.persist(job);
      this.active--;
      this.drainQueue();
    }
  }

  /**
   * Reads the target site for anything the submitter left blank. Without this a
   * build dispatched with an empty description ships advertising Pake's tagline,
   * and one with no icon ships Pake's logo — and the form having failed to fill
   * itself in is exactly when that happens.
   */
  private async fillGapsFromSite(job: Job): Promise<void> {
    if (job.input.description && job.input.icon) return;
    try {
      const site = await readSiteMetadata(job.input.url);
      if (!job.input.description && site.description) {
        job.input.description = site.description;
        job.log.push('\u2139 Description read from the site.');
      }
      if (!job.input.icon && site.icon && site.iconUsable) {
        job.input.icon = site.icon;
        job.log.push('\u2139 Icon read from the site.');
      }
      if (!job.input.description) {
        job.log.push(`\u26a0 No description found on the site${site.fetchNote ? `: ${site.fetchNote}` : '.'}`);
      }
      this.persist(job);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      job.log.push(`\u26a0 Could not read the site for missing details: ${reason}`);
      console.error(`[metadata] could not enrich ${job.id}:`, err);
    }
  }

  /** Dispatch returns no run id, so match the run by the build id in its name. */
  private async locateRun(job: Job): Promise<number> {
    job.status = 'locating';
    this.persist(job);
    const searchFrom = job.createdAt;

    for (let attempt = 0; attempt < RUN_APPEAR_ATTEMPTS; attempt++) {
      await sleep(Math.min(attempt === 0 ? 3000 : 4000, this.pollIntervalMs));
      const run = await this.gh.findRun(job.buildId, searchFrom);
      if (run) {
        job.runId = run.id;
        job.runUrl = run.html_url;
        job.log.push(`\u2713 Run found \u2192 ${run.html_url}`);
        this.persist(job);
        return run.id;
      }
    }
    throw new Error(
      'No workflow run appeared. Check that build.yml is on the default branch and the token grants Actions write.',
    );
  }

  private async followRun(job: Job, runId: number): Promise<string> {
    job.status = 'running';
    this.persist(job);
    const deadline = Date.now() + RUN_TIMEOUT_MS;


    for (let tick = 0; Date.now() < deadline; tick++) {
      if (this.removed.has(job.id)) throw new Error('Build was removed.');
      await this.waitForNextPoll(job.id);
      if (this.removed.has(job.id)) throw new Error('Build was removed.');
      const runJobs = await this.gh.listJobs(runId);
      job.legs = runJobs
        .filter((leg) => MATRIX_LEG_NAME.test(leg.name))
        .map((leg) => ({
          os: platformOf(leg),
          status: leg.status,
          conclusion: leg.conclusion,
        }));
      this.persist(job);

      // GitHub publishes each platform's artifact the moment that job uploads
      // it, so a finished leg means its installers are already downloadable.
      // Waiting for the whole matrix would leave a fast Linux build idle while
      // macOS compiles for another ten minutes.
      // Retried every tick until each finished platform's files are actually on
      // disk. GitHub can report a job complete a moment before its artifact is
      // listable, and trying only once left those installers invisible until
      // the whole matrix ended.
      const awaitingArtifacts = job.legs.some(
        (leg) =>
          leg.status === 'completed' &&
          (!leg.conclusion || leg.conclusion === 'success') &&
          !job.artifacts.some((artifact) => artifact.os === leg.os),
      );
      if (awaitingArtifacts) await this.collectArtifacts(job, runId);

      const allLegsFinished =
        runJobs.length > 0 && runJobs.every((leg) => leg.status === 'completed');
      if (allLegsFinished || tick % RUN_RECHECK_EVERY === RUN_RECHECK_EVERY - 1) {
        const run = await this.gh.getRun(runId);
        if (run.status === 'completed') {
          job.log.push(`\u2713 Run completed: ${run.conclusion ?? 'unknown'}`);
          return run.conclusion ?? 'unknown';
        }
      }
    }
    throw new Error('Gave up waiting for the run to finish after 40 minutes.');
  }

  /**
   * Copy each artifact zip out of GitHub and unpack it under the job directory,
   * so downloads keep working past GitHub's retention window.
   */
  /**
   * Mirrors any artifact not already on disk. Safe to call repeatedly: each
   * platform is copied once, so it can run mid-run as legs finish and again at
   * the end to sweep up whatever landed last.
   */
  private async collectArtifacts(job: Job, runId: number): Promise<void> {
    let artifacts;
    try {
      artifacts = await this.gh.listArtifacts(runId);
    } catch (err) {
      // Mid-run this is not worth failing over; the final pass will retry.
      console.error(`[artifacts] list failed for ${job.id}:`, err);
      return;
    }

    const alreadyHave = new Set(job.artifacts.map((artifact) => artifact.os));
    for (const artifact of artifacts.filter((candidate) => !candidate.expired)) {
      const platform = platformOfArtifact(artifact.name);
      if (alreadyHave.has(platform)) continue;
      alreadyHave.add(platform);

      job.log.push(`\u2193 ${artifact.name}`);
      this.persist(job);

      const unpacked = unzipSync(await this.gh.downloadArtifact(artifact.id));
      const platformDir = path.join(this.jobDir(job.id), platform);
      await mkdir(platformDir, { recursive: true });

      for (const [entryPath, bytes] of Object.entries(unpacked)) {
        if (entryPath.endsWith('/') || bytes.length === 0) continue;

        // The workflow ships a report describing what it actually produced.
        // Fold it into the build log rather than offering it as a download, so
        // a wrong description or a duplicate launcher is visible immediately.
        if (path.basename(entryPath) === 'build-report.txt') {
          for (const line of new TextDecoder().decode(bytes).trim().split('\n')) {
            if (line.trim()) job.log.push(`   ${platform}: ${line.trim()}`);
          }
          continue;
        }

        const destination = path.join(platformDir, entryPath);
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, bytes);
        job.artifacts.push({
          os: platform,
          file: `${platform}/${entryPath}`,
          name: path.basename(entryPath),
          size: bytes.length,
        });
      }
      // Persist per artifact so the browser sees each download appear.
      this.persist(job);
    }
  }

  /** Final sweep once the run is over, then decide how the build ended. */
  private async finishBuild(job: Job, runId: number, conclusion: string): Promise<void> {
    job.status = 'collecting';
    this.persist(job);

    const expected = job.legs
      .filter((leg) => leg.status === 'completed' && (!leg.conclusion || leg.conclusion === 'success'))
      .map((leg) => leg.os);

    for (let attempt = 0; attempt < ARTIFACT_SETTLE_ATTEMPTS; attempt++) {
      await this.collectArtifacts(job, runId);
      const have = new Set(job.artifacts.map((artifact) => artifact.os));
      if (expected.every((os) => have.has(os))) break;
      if (attempt === ARTIFACT_SETTLE_ATTEMPTS - 1) {
        const missing = expected.filter((os) => !have.has(os));
        if (missing.length) {
          job.log.push(`\u26a0 No artifact appeared for ${missing.join(', ')}.`);
        }
        break;
      }
      await sleep(ARTIFACT_SETTLE_MS);
    }

    if (!job.artifacts.length) {
      throw new Error(`Run concluded "${conclusion}" without producing artifacts.`);
    }

    job.status = 'done';
    if (conclusion !== 'success') {
      job.warning = `The run ended as "${conclusion}". The installers below are the platforms that finished.`;
    }
    job.log.push('\u2713 Done.');
  }

  // ---- manual control -----------------------------------------------------

  /**
   * Resolves the current wait for every in-flight build so a person pressing
   * "Check now" sees GitHub's latest state instead of waiting out the interval.
   * Returns how many builds were nudged.
   */
  checkNow(): number {
    const pending = [...this.waiters.values()];
    for (const wake of pending) wake();
    return pending.length;
  }

  /** Forget a build and delete its installers. Returns false if it never existed. */
  async remove(id: string): Promise<boolean> {
    if (!this.jobs.has(id)) return false;
    this.removed.add(id);
    this.jobs.delete(id);
    this.db.remove(id);
    this.waiters.get(id)?.(); // let an in-flight poll notice and unwind
    await this.discard(this.jobDir(id));
    return true;
  }

  private waitForNextPoll(jobId: string): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        if (this.waiters.get(jobId) === finish) this.waiters.delete(jobId);
        resolve();
      };
      const timer = setTimeout(finish, this.pollIntervalMs);
      this.waiters.set(jobId, finish);
    });
  }

  // ---- downloads ----------------------------------------------------------

  /** Resolve an artifact path, refusing anything not recorded against this job. */
  async artifactPath(job: Job, relativePath: string): Promise<string | null> {
    if (!job.artifacts.some((artifact) => artifact.file === relativePath)) return null;
    const absolute = path.join(this.jobDir(job.id), relativePath);
    try {
      await stat(absolute);
      return absolute;
    } catch {
      return null;
    }
  }

  // ---- retention ----------------------------------------------------------

  /**
   * Drop jobs past the retention window and delete any directory on disk with
   * no surviving record, which is what stops the volume growing without bound.
   */
  async sweep(): Promise<void> {
    const cutoff = Date.now() - this.options.retentionDays * 24 * 60 * 60 * 1000;

    for (const id of this.db.expiredBefore(cutoff)) {
      const job = this.jobs.get(id);
      if (job && UNFINISHED.includes(job.status)) continue; // never cull a live build
      this.jobs.delete(id);
      this.db.remove(id);
      await this.discard(this.jobDir(id));
    }

    let entries: Dirent[];
    try {
      entries = await readdir(this.buildDir, { withFileTypes: true });
    } catch {
      // The directory can be missing on a fresh volume; recreate and move on.
      await mkdir(this.buildDir, { recursive: true }).catch(() => {});
      return;
    }

    for (const entry of entries) {
      // Only job directories are ours to delete. Skipping everything else
      // leaves alone the lost+found that ext4 creates at a volume root, which
      // is present whenever the volume is mounted at the build directory.
      if (!entry.isDirectory() || entry.name === 'lost+found') continue;
      if (this.jobs.has(entry.name)) continue;
      await this.discard(path.join(this.buildDir, entry.name));
    }
  }

  /** Never let a sweep failure reach the caller — at boot that would exit the process. */
  private async sweepQuietly(): Promise<void> {
    try {
      await this.sweep();
    } catch (err) {
      console.error('[sweep] skipped:', err);
    }
  }

  /**
   * Remove one build directory, never the build root. On a container the root
   * is a volume mount point, and rmdir on a mount point fails with EBUSY — a
   * failure that used to abort startup and leave the container restarting.
   */
  private async discard(target: string): Promise<void> {
    const resolved = path.resolve(target);
    if (resolved === path.resolve(this.buildDir) || resolved === path.dirname(resolved)) {
      console.error(`[sweep] refusing to remove ${resolved}: not a build directory`);
      return;
    }
    try {
      await rm(resolved, { recursive: true, force: true });
    } catch (err) {
      // A stuck directory costs disk, not uptime.
      console.error(`[sweep] could not remove ${resolved}:`, err);
    }
  }
}

/** Fingerprints a spec so an identical resubmission can be recognised. */
function specKey(input: BuildInput): string {
  return [
    input.url.trim().replace(/\/+$/, '').toLowerCase(),
    input.name.trim().toLowerCase(),
    (input.description ?? '').trim().toLowerCase(),
    [...input.platforms].sort().join('+'),
    (input.icon ?? '').trim().toLowerCase(),
    input.width,
    input.height,
  ].join('|');
}

function platformOf(leg: RunJob): string {
  return leg.name.match(MATRIX_LEG_NAME)?.[1].toLowerCase() ?? leg.name;
}

function platformOfArtifact(artifactName: string): string {
  return PLATFORM_SUFFIXES.find((p) => artifactName.endsWith(`-${p}`)) ?? 'unknown';
}
