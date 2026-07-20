import { readFile, mkdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { GitHub } from './github';
import { JobDatabase } from './db';
import { JobStore } from './jobs';
import { PLATFORMS, type BuildInput, type Job, type Platform } from './types';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PORT = Number(process.env.PORT ?? 3000);
const DATA_DIR = process.env.DATA_DIR ?? '/data';
const BUILD_DIR = process.env.BUILD_DIR ?? path.join(DATA_DIR, 'builds');
const DB_FILE = process.env.DB_FILE ?? path.join(DATA_DIR, 'jobs.db');

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}. See .env.example.`);
    process.exit(1);
  }
  return value;
}

const github = new GitHub({
  owner: requireEnv('GITHUB_OWNER'),
  repo: requireEnv('GITHUB_REPO'),
  token: requireEnv('GITHUB_TOKEN'),
  workflowFile: process.env.WORKFLOW_FILE ?? 'build.yml',
  ref: process.env.GIT_REF ?? 'main',
  apiBase: process.env.GITHUB_API_BASE,
});

await mkdir(BUILD_DIR, { recursive: true });
const database = new JobDatabase(DB_FILE);
const store = new JobStore(github, BUILD_DIR, database, {
  maxActive: Number(process.env.MAX_ACTIVE ?? 4),
  retentionDays: Number(process.env.RETENTION_DAYS ?? 7),
});
await store.start();

const app = Fastify({ logger: true, bodyLimit: 1_048_576 });
const indexHtml = await readFile(path.join(projectRoot, 'public', 'index.html'), 'utf-8');
app.get('/', async (_request, reply) => reply.type('text/html').send(indexHtml));

const APP_NAME = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,49}$/;
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

app.post('/api/builds', async (request, reply) => {
  const payload = (request.body ?? {}) as Record<string, unknown>;
  const url = String(payload.url ?? '').trim();
  const name = String(payload.name ?? '').trim();
  const platforms = (Array.isArray(payload.platforms) ? payload.platforms : [])
    .map(String)
    .filter((candidate): candidate is Platform => (PLATFORMS as string[]).includes(candidate));

  if (!/^https?:\/\/.+/i.test(url)) {
    return reply.code(400).send({ error: 'Enter a URL starting with http:// or https://' });
  }
  if (!APP_NAME.test(name)) {
    return reply.code(400).send({
      error: 'App name must start with a letter or number, and use only letters, numbers, spaces, hyphens or underscores (max 50).',
    });
  }
  if (!platforms.length) {
    return reply.code(400).send({ error: 'Choose at least one platform to build for.' });
  }

  const input: BuildInput = {
    url,
    name,
    platforms,
    icon: payload.icon ? String(payload.icon).trim() : undefined,
    width: clamp(Number(payload.width) || 1200, 320, 5000),
    height: clamp(Number(payload.height) || 780, 240, 5000),
  };
  return reply.code(202).send({ id: store.submit(input).id });
});

app.get('/api/builds', async () => ({ jobs: store.list().map(toClientJob) }));

app.get('/api/builds/:id', async (request, reply) => {
  const job = store.get((request.params as { id: string }).id);
  if (!job) return reply.code(404).send({ error: 'No build with that id.' });
  const alreadySeen = Number((request.query as { after?: string }).after ?? 0) || 0;
  return { ...toClientJob(job), log: job.log.slice(alreadySeen), logCount: job.log.length };
});

// Wildcard so nested artifact paths like "macos/MyApp.dmg" resolve.
app.get('/api/builds/:id/file/*', async (request, reply) => {
  const job = store.get((request.params as { id: string }).id);
  if (!job) return reply.code(404).send({ error: 'No build with that id.' });

  const requested = (request.params as Record<string, string>)['*'];
  const absolute = await store.artifactPath(job, requested);
  if (!absolute) return reply.code(404).send({ error: 'That installer is no longer available.' });

  reply.header('Content-Disposition', `attachment; filename="${path.basename(requested)}"`);
  reply.type('application/octet-stream');
  return reply.send(createReadStream(absolute));
});

app.get('/api/health', async () => ({ ok: true }));

function toClientJob(job: Job) {
  const { log, ...rest } = job;
  return rest;
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    store.stop();
    app.close().then(() => {
      database.close();
      process.exit(0);
    });
  });
}

app
  .listen({ port: PORT, host: '0.0.0.0' })
  .then(() => app.log.info(`Pake Cloud Builder listening on :${PORT}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
