# Drifter Sandbox Session Architecture (MVP)

## Goal

Run drifter experiments inside a **disposable sandbox** so that:

- the active play session is isolated from the canonical repo checkout,
- generated artifacts stay inside the sandbox,
- repo/worktree, world copy, session state, reports, and artifacts live together,
- teardown is cheap and explicit.

This is an MVP architecture and prototype: practical first, intentionally narrow.

## Core idea

A drifter run gets a dedicated filesystem root outside the main repo tree by default:

```text
/tmp/trpg-runtime-v2/sandboxes/<sandbox-id>/
```

Inside that root, everything needed for the experiment is colocated:

```text
<sandbox>/
  sandbox-manifest.json
  .gitignore
  repo/
    worktree/           # optional git worktree anchored to source repo HEAD/ref
  world/
    base/               # copied world source snapshot for this experiment
  session/
    session.json        # lightweight sandbox/session metadata
    live/               # runtime-owned mutable state
  reports/              # summaries, evals, operator notes
  artifacts/            # screenshots, traces, exports, generated outputs
  tmp/                  # scratch space
```

## Design choices

### 1) Sandbox is disposable, not canonical

The sandbox is **not** the source of truth. It is a per-run envelope.

Canonical assets may be copied in, but sandboxes are expected to be deleted after evaluation.

### 2) Runtime outputs stay in the sandbox

Reports, scratch files, traces, and experiment outputs are written under the sandbox root, not under:

- `runtime/reports/`
- `workspace/`
- repo-level temp folders

That keeps the main tree cleaner and makes cleanup trivial.

### 3) Repo isolation uses git worktree

The prototype can materialize `repo/worktree/` with:

```bash
git worktree add --detach <sandbox>/repo/worktree <ref>
```

Why worktree:

- fast reuse of the existing repo object database,
- cheap isolation from the dirty main checkout,
- predictable teardown with `git worktree remove`.

### 4) World is copied, not mounted

For MVP, `world/` is a **copy** into `world/base/`.

That gives the session permission to mutate without risking canonical files.
Later versions can support overlays, reflinks, rsync incrementals, or read-only bind mounts.

### 5) Manifest-first lifecycle

`sandbox-manifest.json` is the source of truth for the disposable environment.
It records:

- source repo root + ref,
- source world root,
- created paths,
- destroy command,
- worktree presence.

## Lifecycle

### Create

1. Pick parent root (default: OS temp area).
2. Generate sandbox ID.
3. Create directory skeleton.
4. Copy world snapshot into `world/base/` if provided.
5. Create git worktree at `repo/worktree/` unless disabled.
6. Seed `session/session.json`, report/artifact READMEs, and manifest.

### Run

Consumers should treat paths from the manifest as the session-local roots.
For example:

- operate in `repo/worktree/` for code or prompt experiments,
- treat `world/base/` + `session/live/` as the world/session envelope,
- emit evaluation summaries to `reports/`,
- emit generated assets to `artifacts/`.

### Destroy

1. Remove git worktree if present.
2. Recursively delete sandbox root.

## CLI prototype

Implemented script:

```bash
node ./scripts/drifter-sandbox.mjs create
node ./scripts/drifter-sandbox.mjs inspect --sandbox <path>
node ./scripts/drifter-sandbox.mjs destroy --sandbox <path>
```

Key flags:

- `--repo <path>`: source repo root
- `--world <path>`: world root to snapshot
- `--parent <path>`: sandbox parent directory
- `--label <name>`: human-readable label prefix
- `--ref <git-ref>`: ref/commit for detached worktree
- `--no-worktree`: create sandbox layout without a repo worktree
- `--force`: force worktree removal on destroy

## What this MVP does not do yet

Not implemented yet:

- overlayfs/reflink world layering,
- automatic runtime wiring from existing OpenClaw tools into sandbox manifests,
- retention policies / LRU cleanup,
- artifact indexing/search,
- session resume registry across multiple sandbox runs,
- automatic promotion of a sandbox back into canonical world state.

## Current MVP session wiring

A practical launcher now exists:

```bash
node ./scripts/run-drifter-sandbox-session.mjs
```

Minimal flow:

1. create or inspect sandbox manifest,
2. choose sandbox worktree (or source repo when `--no-worktree`),
3. run `scripts/run-gamer-smoke-live.mjs` with:
   - `--world-root <sandbox>/world/base`
   - `--preserve-world-root`
   - `--transcript-dir <sandbox>/session/transcripts`
   - `--improve-report-dir <sandbox>/reports`
4. capture stdout/stderr logs into `<sandbox>/artifacts/`,
5. persist launch summary into `<sandbox>/session/launch-result.json`.

This is intentionally still a runnable MVP slice, not full `/trpg new` production routing.
It proves that an actual drifter/gamer session can execute against sandbox-local world/session/report paths without writing into the main repo world or default runtime report folders.

## Sandbox diff / promotion summary MVP

A post-run reporting layer now exists for sandbox inspection:

```bash
node ./scripts/drifter-sandbox-report.mjs --sandbox <sandbox-root>
```

It writes sandbox-local files under `<sandbox>/reports/`:

- `sandbox-diff-summary.json`
- `sandbox-diff-summary.md`

Current MVP behavior:

- compares `world/base/` against the canonical `source.worldSourceRoot`,
- inventories sandbox `reports/`, `session/transcripts/`, and `artifacts/`,
- reads sandbox machine reports when present,
- inspects sandbox worktree `git status` when present,
- emits **promotion candidates** for changed/new world files and sandbox code changes,
- keeps all generated outputs inside the sandbox.

Promotion remains review-first. The tool identifies candidates; it does **not** write back into canonical paths.

## Current launcher behavior

`node ./scripts/run-drifter-sandbox-session.mjs` now runs the post-run summary step by default after the live smoke/session command completes. You can disable it with:

- `--no-post-report`

## Remaining follow-up

Still not done:

- direct `/trpg new` integration with sandbox request/selection,
- resume registry across multiple drifter sandbox runs,
- richer artifact indexing / transcript search,
- automatic cleanup / retention policy,
- automatic promotion flow from sandbox back into canonical world state,
- failure-analysis / patch-candidate generation on top of the diff summary.
