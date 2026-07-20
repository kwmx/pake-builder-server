import { DatabaseSync } from 'node:sqlite';
import type { ArtifactFile, Job, LegStatus, Platform } from './types';

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  build_id    TEXT NOT NULL,
  url         TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  icon        TEXT,
  width       INTEGER NOT NULL,
  height      INTEGER NOT NULL,
  platforms   TEXT NOT NULL,
  status      TEXT NOT NULL,
  run_id      INTEGER,
  run_url     TEXT,
  error       TEXT,
  warning     TEXT,
  legs        TEXT NOT NULL,
  artifacts   TEXT NOT NULL,
  log         TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS jobs_created_at ON jobs (created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_finished_at ON jobs (finished_at);
`;

/** SQLite row shape — snake_case mirrors the columns above. */
interface JobRow {
  id: string;
  build_id: string;
  url: string;
  name: string;
  description: string | null;
  icon: string | null;
  width: number;
  height: number;
  platforms: string;
  status: string;
  run_id: number | null;
  run_url: string | null;
  error: string | null;
  warning: string | null;
  legs: string;
  artifacts: string;
  log: string;
  created_at: number;
  finished_at: number | null;
}

function rowToJob(row: JobRow): Job {
  return {
    id: row.id,
    buildId: row.build_id,
    input: {
      url: row.url,
      name: row.name,
      description: row.description ?? undefined,
      icon: row.icon ?? undefined,
      width: row.width,
      height: row.height,
      platforms: row.platforms.split(',').filter(Boolean) as Platform[],
    },
    status: row.status as Job['status'],
    runId: row.run_id ?? undefined,
    runUrl: row.run_url ?? undefined,
    error: row.error ?? undefined,
    warning: row.warning ?? undefined,
    legs: JSON.parse(row.legs) as LegStatus[],
    artifacts: JSON.parse(row.artifacts) as ArtifactFile[],
    log: JSON.parse(row.log) as string[],
    createdAt: row.created_at,
    finishedAt: row.finished_at ?? undefined,
  };
}

/**
 * Durable job history. Without this the build list lives only in memory, so a
 * redeploy loses every record and strands the downloaded installers on disk.
 */
export class JobDatabase {
  private db: DatabaseSync;
  private upsert;
  private selectAll;
  private selectExpired;
  private deleteById;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
    this.addMissingColumns();

    this.upsert = this.db.prepare(`
      INSERT INTO jobs (id, build_id, url, name, description, icon, width, height,
                        platforms, status, run_id, run_url, error, warning, legs,
                        artifacts, log, created_at, finished_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        status=excluded.status, run_id=excluded.run_id, run_url=excluded.run_url,
        error=excluded.error, warning=excluded.warning, legs=excluded.legs,
        artifacts=excluded.artifacts, log=excluded.log,
        finished_at=excluded.finished_at
    `);
    this.selectAll = this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC');
    this.selectExpired = this.db.prepare(
      'SELECT id FROM jobs WHERE COALESCE(finished_at, created_at) < ?',
    );
    this.deleteById = this.db.prepare('DELETE FROM jobs WHERE id = ?');
  }

  /** CREATE TABLE IF NOT EXISTS is a no-op on an existing table, so columns
   *  added after a database was first created have to be applied by hand. */
  private addMissingColumns(): void {
    const present = new Set(
      (this.db.prepare('PRAGMA table_info(jobs)').all() as unknown as { name: string }[])
        .map((column) => column.name),
    );
    if (!present.has('description')) {
      this.db.exec('ALTER TABLE jobs ADD COLUMN description TEXT');
    }
  }

  save(job: Job): void {
    this.upsert.run(
      job.id,
      job.buildId,
      job.input.url,
      job.input.name,
      job.input.description ?? null,
      job.input.icon ?? null,
      job.input.width,
      job.input.height,
      job.input.platforms.join(','),
      job.status,
      job.runId ?? null,
      job.runUrl ?? null,
      job.error ?? null,
      job.warning ?? null,
      JSON.stringify(job.legs),
      JSON.stringify(job.artifacts),
      JSON.stringify(job.log),
      job.createdAt,
      job.finishedAt ?? null,
    );
  }

  loadAll(): Job[] {
    return (this.selectAll.all() as unknown as JobRow[]).map(rowToJob);
  }

  /** Ids of jobs whose last activity predates `cutoff`, for the retention sweep. */
  expiredBefore(cutoff: number): string[] {
    return (this.selectExpired.all(cutoff) as unknown as { id: string }[]).map((r) => r.id);
  }

  remove(id: string): void {
    this.deleteById.run(id);
  }

  close(): void {
    this.db.close();
  }
}
