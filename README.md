# Pake Cloud Builder

A containerised web app that turns any URL into desktop apps for **Linux, Windows and macOS** — and does it **for free**. The app itself carries no build toolchain: it dispatches builds to **GitHub Actions** and hands you the installers. The whole thing runs in one small container.

```
Browser ──▶ Web app (this container) ──▶ GitHub Actions (public repo)
                    ▲                          │  ubuntu / windows / macos runners
                    └──── installers ◀─────────┘  build in parallel, free
```

---

## Why this is free (and how)

GitHub Actions bills by the minute on **private** repos, with macOS draining your allowance 10× as fast as Linux. But **standard-runner minutes are unlimited and free on _public_ repositories, on every plan** — Linux, Windows *and* macOS. So the trick is simple:

> Put the build workflow in a **public** repo. Keep the web app (and your token) wherever you like — private, local, homelab. The public repo contains only `build.yml`; no secrets, no app code.

That's the entire cost model. As of 2026: public repos = free; private repos = 2,000 free min/mo (Free plan), then Linux $0.006/min, Windows $0.010/min, macOS $0.062/min, with 1× / 2× / 10× allowance multipliers. macOS is the expensive one because Apple licensing forces real Mac hardware — which is also why it can't be containerised, and why GitHub Actions is the pragmatic way to get free macOS builds.

**Trade-off to accept:** on a public repo, the build inputs (the URL and app name you submit) and the Actions logs are publicly visible on that repo's Actions tab. The artifacts are only downloadable by people with the link for the retention window, but assume the *inputs* are public. That's fine for packaging public websites. If you need privacy, see "Staying free but private" below.

---

## Setup (about 10 minutes)

### 1. Create the public builder repo

1. Create a new **public** repo, e.g. `pake-builder`.
2. Add the workflow at `.github/workflows/build.yml` — copy it from [`builder-repo/.github/workflows/build.yml`](builder-repo/.github/workflows/build.yml) in this project.
3. Commit to the **default branch** (`main`). `workflow_dispatch` only works for workflows present on the default branch — no manual run needed first.
4. Public repos have Actions enabled by default. (Settings → Actions → General, if you ever need to check.)

### 2. Create a scoped token

Go to **Settings → Developer settings → Fine-grained personal access tokens** → *Generate new token*:

- **Repository access:** Only select repositories → `pake-builder`
- **Permissions:**
  - `Actions` → **Read and write** (needed to dispatch)
  - `Contents` → **Read-only**
  - `Metadata` → **Read-only** (auto-selected)

Copy the token — you'll paste it into `.env`.

> For a shared/production deployment, use a **GitHub App** installation token instead of a PAT (short-lived, revocable, org-friendly). The `GitHub` client only needs a Bearer token, so swapping in App auth is a drop-in change.

### 3. Configure and run the web app

```bash
cp .env.example .env
# edit .env: set GITHUB_OWNER, GITHUB_REPO (pake-builder), GITHUB_TOKEN
docker compose up --build
# open http://localhost:3000
```

Enter a URL, a name, tick the platforms, hit **Build apps**. You'll see the run get dispatched, each platform's leg turn from queued → in progress → done, a "view run" link to GitHub, and download buttons for each installer as they land.

---

## How it works (the four steps)

1. **Dispatch** — `POST …/actions/workflows/build.yml/dispatches` with the inputs and a unique `build_id`. Returns `204` with no run id.
2. **Correlate** — the workflow sets `run-name: "build <build_id>"`, so the app lists recent `workflow_dispatch` runs and matches the name to recover the run id.
3. **Poll** — `GET …/actions/runs/{id}` until `completed`, refreshing each platform's leg status from `…/runs/{id}/jobs` along the way.
4. **Collect** — `GET …/runs/{id}/artifacts`, download each zip (following the 302 to the signed URL without leaking the token), unzip, and serve the installers.

All of this lives in `src/github.ts` (API) and `src/jobs.ts` (orchestration).

---

## Limits & notes

- **Output formats:** Linux produces **`.deb` + `.rpm` + `.AppImage`**, Windows `.msi`, macOS `.dmg`.
- **Toolchain:** every platform runs the `pake-cli` npm package directly, pinned by `PAKE_VERSION` at the top of `build.yml`. The `tw93/Pake` *action* is deliberately not used — Pake publishes only full version tags (`V3.15.1`, capital V) with no moving `v3`, so action refs break on upgrade. Bump the npm version in one place instead.
- **`--targets` is platform-dependent:** on Linux it selects *formats* (`deb,rpm,appimage`, with per-format failures isolated so `.deb`/`.rpm` still ship if AppImage's FUSE step fails). On **Windows and macOS it selects *architecture*** (`x64`/`arm64`, `intel`/`apple`/`universal`) — the format there is fixed at `.msi`/`.dmg` — so the workflow omits it and builds for the runner's native arch.
- **macOS arch:** `macos-latest` is Apple Silicon, so the `.dmg` is arm64-only and won't run on Intel Macs. For a universal binary, uncomment the `rustup target add` step in `build.yml` and append `--targets universal` to the args (roughly doubles build time).
- **Retention:** artifacts are kept 7 days (set in `build.yml`), and the app also caches them in `./builds`. Bump `retention-days` if you want longer.
- **Concurrency:** GitHub Free allows 20 concurrent jobs; the app caps its own in-flight builds via `MAX_ACTIVE` (default 8).
- **First run** on a fresh Pake cache is slower (~10–15 min); later runs are ~5 min. This is GitHub's build time, not the app's.
- **Open access:** anyone who can reach the web app can build an app of any URL. If you expose it beyond localhost, put an auth proxy (e.g. Traefik + forward-auth) in front.

---

## Staying free but private

If you don't want build inputs on a public repo, you have two free-ish routes, both behind the same app:

- **Self-hosted runners on a private repo.** Self-hosted runner minutes are free (the proposed platform fee never took effect). Add a Linux self-hosted runner in your homelab for `linux`; Windows needs a Windows self-hosted runner; macOS still needs a Mac. You'd change the `runner` labels in `build.yml` to your runner labels.
- **Hybrid.** Keep Linux/Windows on your own self-hosted runners (or containers) and use hosted macOS only — macOS is the one you can't self-host without Apple hardware. The app's job model doesn't change; only which runner each leg targets.

For a purely-free, all-three-platforms setup with the least effort, the public-repo path above is the winner.
