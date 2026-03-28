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

## Suggested next step

Integrate current session bootstrap so that `/trpg new` or a drifter-specific entry point can optionally request a sandbox manifest and then route all runtime writes through the manifest layout instead of directly targeting canonical world/workspace paths.
