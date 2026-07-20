import { readFile, mkdir, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { GitHub } from './github';
import { JobStore } from './jobs';
import { PLATFORMS, type Platform, type BuildInput, type Job } from './types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const PORT = Number(process.env.PORT ?? 3000);
const BUILD_DIR = process.env.BUILD_DIR ?? '/data/builds';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`\u2715 Missing required env: ${name}. See .env.example.`);
    process.exit(1);
  }
  return v;
}

const gh = new GitHub({
  owner: requireEnv('GITHUB_OWNER'),
  repo: requireEnv('GITHUB_REPO'),
  token: requireEnv('GITHUB_TOKEN'),
  workflowFile: process.env.WORKFLOW_FILE ?? 'build.yml',
  ref: process.env.GIT_REF ?? 'main',
  apiBase: process.env.GITHUB_API_BASE,
});

// Job records live in memory, so artifacts left on disk by a previous container
// can never be reached again through the API. Clear them on boot, otherwise the
// volume grows without bound on a long-running deployment.
if ((process.env.PURGE_ON_START ?? 'true') !== 'false') {
  await rm(BUILD_DIR, { recursive: true, force: true });
}
await mkdir(BUILD_DIR, { recursive: true });
const store = new JobStore(gh, BUILD_DIR, Number(process.env.MAX_ACTIVE ?? 8));

const app = Fastify({ logger: true, bodyLimit: 1_048_576 });
const INDEX = await readFile(path.join(ROOT, 'public', 'index.html'), 'utf-8');
app.get('/', async (_req, reply) => reply.type('text/html').send(INDEX));

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,49}$/;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

app.post('/api/builds', async (req, reply) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const url = String(b.url ?? '').trim();
  const name = String(b.name ?? '').trim();
  const platforms = (Array.isArray(b.platforms) ? b.platforms : [])
    .map(String)
    .filter((p): p is Platform => (PLATFORMS as string[]).includes(p));

  if (!/^https?:\/\/.+/i.test(url)) return reply.code(400).send({ error: 'A valid http(s) URL is required.' });
  if (!NAME_RE.test(name)) return reply.code(400).send({ error: 'Name: 1\u201350 chars, letters/digits/space/-/_ , starting alphanumeric.' });
  if (!platforms.length) return reply.code(400).send({ error: 'Select at least one platform.' });

  const input: BuildInput = {
    url,
    name,
    platforms,
    icon: b.icon ? String(b.icon).trim() : undefined,
    width: clamp(Number(b.width) || 1200, 320, 5000),
    height: clamp(Number(b.height) || 780, 240, 5000),
  };
  const job = store.create(input);
  return reply.code(202).send({ id: job.id });
});

app.get('/api/builds', async () => ({ jobs: store.list().map(view) }));

app.get('/api/builds/:id', async (req, reply) => {
  const job = store.get((req.params as { id: string }).id);
  if (!job) return reply.code(404).send({ error: 'Not found' });
  const after = Number((req.query as { after?: string }).after ?? 0) || 0;
  return { ...view(job), log: job.log.slice(after), logCount: job.log.length };
});

// Wildcard captures nested artifact paths like "macos/MyApp.dmg".
app.get('/api/builds/:id/file/*', async (req, reply) => {
  const job = store.get((req.params as { id: string }).id);
  if (!job) return reply.code(404).send({ error: 'Not found' });
  const rel = (req.params as Record<string, string>)['*'];
  const full = await store.fileFor(job, rel);
  if (!full) return reply.code(404).send({ error: 'Artifact not found' });
  reply.header('Content-Disposition', `attachment; filename="${path.basename(rel)}"`);
  reply.type('application/octet-stream');
  return reply.send(createReadStream(full));
});

app.get('/api/health', async () => ({ ok: true }));

function view(job: Job) {
  const { id, buildId, input, status, runUrl, legs, artifacts, error, warning, createdAt, finishedAt } = job;
  return { id, buildId, input, status, runUrl, legs, artifacts, error, warning, createdAt, finishedAt };
}

app
  .listen({ port: PORT, host: '0.0.0.0' })
  .then(() => app.log.info(`Pake Cloud Builder on :${PORT}`))
  .catch((e) => {
    app.log.error(e);
    process.exit(1);
  });
