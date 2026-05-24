# Multi-agent git setup — READ THIS BEFORE TOUCHING `git`

**Read this immediately after `01_PROJECT_RULES.md` and before doing
anything else.** It is the second-most-important file in the repo
behind the project rules. If you skip it, you WILL eventually push a
commit that overwrites or sweeps in another agent's work and the
owner WILL be unhappy.

---

## The setup, in one paragraph

CaptureShark lives on the owner's **local Windows machine** as a
**single git checkout** of one branch (`main`). **One or more Claude
Code agents work this checkout in parallel, at the same time**, each
owning a different slice of the app. The number of agents may
change — could be one solo session, two like today, four during a
larger push. There is NO worktree. There are NO feature branches.
Every agent commits to `main` and pushes to the same remote. The
git index (the staging area between your working tree and a commit)
is a **shared resource** — when you `git add`, your file joins
whatever the other agents have staged, and a bare `git commit`
captures ALL of it. That is the failure mode this doc exists to
prevent.

## Why no branches, why no worktrees

* **One checkout = one branch.** `git switch <other-branch>` in this
  checkout flips the branch for EVERY agent mid-edit. They lose
  their working state and break instantly. Banned.
* **Worktrees were tried, banned by the owner.** A previous attempt
  had agents in separate worktrees, then one tried to spin up a new
  dev server when ports collided, then mobile testing broke, then
  the tunnel pointed at the wrong tree. Net: worse than the
  original problem. Worktrees are banned on this project.
* **So we cooperate on the same branch.** That's the contract.
  Everything in this doc exists to make that safe.

---

## Who owns what — the territory registry

The single source of truth is
[`.githooks/agent-territories.json`](../../.githooks/agent-territories.json).

That file lists every agent currently working on the repo, along
with the paths each one owns exclusively. The pre-commit hook
reads it on every commit, so adding / removing / renaming agents
is a one-file edit — no code changes, no per-agent hook variants.

Today's roster is whatever's in the registry when you read it.
Examples that have existed:

* `queue` — offline queue, drainer, PWA / offline app shell.
* `photo` — photo capture flow, vision extraction, bake-off
  scripts.

To see the current roster:

```sh
cat .githooks/agent-territories.json
```

**Shared files** (any agent may touch — coordinate manually):
anything NOT listed under an agent's `exclusive_paths` in the
registry. Common examples: `frontend/src/App.canvas.tsx`,
`frontend/src/App.canvas.css`, `frontend/src/main.tsx`,
`frontend/src/features/review/**`, `frontend/src/lib/api.ts`,
`frontend/vite.config.ts`, `frontend/package.json`,
`frontend/pnpm-lock.yaml`,
`backend/src/captureshark/api/deps.py`, `docs/_dev/09_TODO.md`,
`docs/_workflow/02_PRINCIPLES.md`, `docs/_workflow/**`.

If you do not know which agent role you are, **stop and ask the
owner**. Do not commit anything until you know.

---

## The mechanical guard (DO NOT skip the install)

Memory and good intentions are not enough — a real incident on
2026-05-16 proved that. Two hooks together make the failure mode
impossible:

### Layer 1: Git `pre-commit` hook

Lives at `.git/hooks/pre-commit`. Runs every time you `git commit`.
Reads the territory registry, then looks at the paths staged for
this commit:

* If they fall under **zero** agents' exclusive territories (all
  shared / cleanup) → allow.
* If they fall under **exactly one** agent's territory (plus any
  shared paths) → allow. That agent is the implied author.
* If they span **two or more** agents' exclusive territories → REJECT.
  This commit is sweeping in another agent's in-progress work.
  The rejection message lists which paths belong to which owner.

No role configuration is needed — the hook derives "who you are"
from what you staged. This is intentional: an earlier design used a
`.git/info/agent-role` file, but that file lives in the shared
working tree, both agents could overwrite it, and the race
condition recreated the original bug. The path-based derivation has
no shared state, so no race.

`.git/hooks/` is not tracked by git, so each agent's checkout must
install the hook locally. The hook script and registry ARE tracked,
at `.githooks/`.

### Layer 2: Claude Code `PreToolUse` hook on `Bash`

Lives in `.claude/settings.local.json`. Runs every time Claude tries
to execute a Bash command. Rejects two patterns regardless of role:

1. `git commit` without path-scoping. You must use
   `git commit -m "..." -- <path 1> <path 2> ...`. A bare
   `git commit -m "msg"` is rejected.
2. Broad `git add`: `git add .`, `git add -A`, `git add --all`,
   `git add -u`. You must list paths explicitly:
   `git add path/to/file1 path/to/file2`.

The script lives at `.githooks/check-git-command.py` and is
shared by every agent.

---

## First-session install (DO THIS BEFORE COMMITTING ANYTHING)

### Step 1 — Confirm your territory is in the registry

Open [`.githooks/agent-territories.json`](../../.githooks/agent-territories.json)
and confirm your slice has an entry under `agents`. If it doesn't,
**stop and ask the owner** to add one (with the paths you'll own
exclusively) before continuing. You don't need to declare your
role anywhere locally — the hook derives it from your staged
paths.

### Step 2 — Install the pre-commit hook

```sh
cp .githooks/agent-pre-commit .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

Verify:

```sh
cat .git/hooks/pre-commit | head -3   # shell wrapper that invokes python
```

### Step 3 — Wire the Claude Code PreToolUse hook

Open `.claude/settings.local.json`. If a top-level `"hooks"` key
does not already exist (sibling to `"permissions"`), add this block:

```json
"hooks": {
  "PreToolUse": [
    {
      "matcher": "Bash",
      "hooks": [
        {
          "type": "command",
          "command": "python .githooks/check-git-command.py"
        }
      ]
    }
  ]
}
```

If the `"hooks"` key already exists, merge the `"PreToolUse"` entry
into it. Do not duplicate.

### Step 4 — Verify the guard works

Confirm the Claude Code hook is wired by trying any Bash command
that contains a bare `git commit` string — it will be blocked with
a clear stderr message starting with `BLOCKED by Claude Code hook`.

If it does NOT block, something is wrong with your install. Stop
and escalate to the owner.

---

## Adding or removing an agent

When the team changes (new agent joins, existing one rotates off):

1. **Owner** edits `.githooks/agent-territories.json`:
   add or remove the entry under `agents`. Commit + push.
2. **Each existing agent** does NOTHING. Their hook reads the
   registry on every commit, so the new ruleset takes effect the
   moment they next pull.
3. **New agent** follows steps 1-4 above in their first session.

This is the entire flow. No scripts to write, no hooks to swap.

---

## How to commit, every time, from now on

```sh
# 1. Stage explicitly. NEVER `git add .` / `-A` / `--all` / `-u`.
git add frontend/src/lib/queue/drainer.ts \
        frontend/src/lib/queue/drainer.test.ts

# 2. Commit path-scoped. The `--` and the path list are MANDATORY.
git commit -m "Offline queue — your message here" -- \
  frontend/src/lib/queue/drainer.ts \
  frontend/src/lib/queue/drainer.test.ts
```

The `--` token separates options from paths. Everything after `--`
is a path. The path list tells git "only commit THESE paths from
the index, leave the rest alone." This is what makes the commit
safe even if other agents have files staged: theirs stay in the
index, yours go into the commit.

If you hit pre-commit hook rejection, the error names the offending
paths and tells you how to unstage them. Do that, then re-run the
commit. **Never bypass the hook with `--no-verify`.**

---

## Shared files — the danger zone (HOOKS DO NOT PROTECT THESE)

Shared files (anything not listed under an `exclusive_paths` in the
registry) are touchable by any agent. **The hooks DO NOT
auto-block edits to shared files** — there's no way for the hook to
know which agent legitimately needs to change `App.canvas.tsx` on
any given day. Coordination here is on you. The discipline:

1. **Before editing a shared file**: run
   `git status --short <path>`. If another agent has it modified
   (`M`) or staged (`M `), STOP. Either wait, or escalate to the
   owner. Never silently edit on top of their in-flight work — the
   second-saver overwrites the first.
2. **After editing a shared file**: commit it fast, in its own
   path-scoped commit. The smaller the window your edit sits
   uncommitted in the working tree, the smaller the collision
   surface.
3. **Never include a shared file you didn't intend to change** in
   your commit's `-- <paths>` list. The `--` list is your safety
   net only if you keep it accurate.
4. **If you find a merge conflict on a shared file**: STOP. Do not
   arbitrate. Escalate to the owner — they decide whose change wins.

If a shared-file edit is unavoidable AND you suspect the other
agent is currently active in that file, ping the owner before
saving. A 30-second pause beats an hour of merge-conflict cleanup.

---

## What if other agents' files are staged when you're ready to commit?

That's the most common state on this repo. The other agents have
staged their work but haven't committed yet. The hooks handle this
for you: your path-scoped commit (`git commit ... -- <your paths>`)
only captures your paths, the others' staged files stay in the
index untouched, ready for them to commit later.

You do not need to unstage their files. You do not need to wait for
them to commit. Just commit your own paths and move on.

The ONE thing the pre-commit hook checks: it inspects the
would-be-commit tree (the path-scoped slice you asked to commit),
NOT the full index. So as long as your `-- <paths>` list contains
only your own paths, the hook stays quiet.

---

## Pulling and pushing

* **Pull at the start of every session.** All agents push to `main`,
  so others' commits may have landed since your last fetch. Run
  `git pull --rebase origin main` first thing.
* **Push the moment a slice is green** (tests pass, type-check
  passes). Smaller, more frequent pushes shrink the window of
  divergence with other agents.
* **Never push broken state.** Everyone else will pull it and
  their build is now broken too.

---

## Escalation — when to stop and ask the owner

Always escalate to the owner for:

* Server restarts (uvicorn, vite, cloudflared) — owner runs these,
  agents never touch them.
* Env-var changes (`.env`, `.env.local`).
* New dependencies (pnpm add / pip install).
* Collisions on shared files that you can't resolve cleanly.
* Anything that affects another agent's working tree state.
* Branching or worktree questions — the answer is always "no, stay
  on `main`", but escalate if you're tempted.
* Adding a new agent role to the registry — only the owner adds
  entries.

Do not "just try it" on any of the above.

---

## Reference

* `.githooks/agent-territories.json` — the registry of
  agents and their exclusive paths. Edited when the team changes.
* `.githooks/agent-pre-commit` — the generic pre-commit
  hook script. Every agent installs the same file.
* `.githooks/check-git-command.py` — Claude Code
  `PreToolUse` hook script, shared by every agent.

The hook setup was hardened on 2026-05-16 after a real incident
where bare commits crossed the agent territory line. Memory of the
incident lives in `feedback-multi-agent-coordination`. Read this
file every new session; the hooks won't fire correctly if either
side's install drifts.
