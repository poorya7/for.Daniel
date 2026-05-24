#!/usr/bin/env python3
"""Pre-commit hook — rejects commits that mix multiple agents' territories.

Previous design used `.git/info/agent-role` to know "who am I", but
that file is in the SHARED working tree — both agents read/write it
and last writer wins. Race condition, real bug.

This rewrite removes the role file entirely. The hook now decides
purely from the staged paths:

  * If staged paths fall into ZERO agents' exclusive territories,
    every path is shared/cleanup — allow.
  * If staged paths fall into ONE agent's territory (possibly plus
    shared paths), that agent is the implied author — allow.
  * If staged paths span TWO OR MORE agents' exclusive territories,
    this commit is sweeping in another agent's work — reject with
    a per-owner breakdown.

Adding/removing/renaming agents is a one-file edit
(`.githooks/agent-territories.json`). No code changes, no
per-agent hook variants, no role-file plumbing.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


def _repo_root() -> Path:
    out = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        capture_output=True,
        text=True,
        check=True,
    )
    return Path(out.stdout.strip())


def main() -> int:
    root = _repo_root()
    registry_file = root / "scripts" / "git-hooks" / "agent-territories.json"

    if not registry_file.exists():
        # No registry → no rules → allow. Useful for fresh clones
        # before the registry has been written.
        return 0

    try:
        registry = json.loads(registry_file.read_text())
    except json.JSONDecodeError as exc:
        sys.stderr.write(
            f"pre-commit hook: {registry_file} is not valid JSON: {exc}\n"
        )
        return 1

    agents = registry.get("agents", {})
    if not isinstance(agents, dict) or len(agents) < 2:
        # Zero or one agent in the registry → nothing to mix → allow.
        return 0

    staged_out = subprocess.run(
        ["git", "diff", "--cached", "--name-only", "--diff-filter=ACDMR"],
        capture_output=True,
        text=True,
        check=True,
    )
    staged = [line for line in staged_out.stdout.splitlines() if line]
    if not staged:
        return 0

    # Bucket staged paths by owning agent. Paths that don't match any
    # agent's territory are "shared/cleanup" — they get a None owner
    # and are never the cause of a rejection.
    by_owner: dict[str, list[str]] = {}
    owners_hit: set[str] = set()
    for path in staged:
        owner: str | None = None
        for role, info in agents.items():
            for prefix in info.get("exclusive_paths", []):
                if path == prefix or path.startswith(prefix):
                    owner = role
                    break
            if owner is not None:
                break
        if owner is not None:
            by_owner.setdefault(owner, []).append(path)
            owners_hit.add(owner)

    if len(owners_hit) <= 1:
        # Zero or one exclusive territory touched → safe to commit.
        return 0

    # Mixed-territory commit — reject with a per-owner breakdown.
    msg: list[str] = [
        "",
        "================================================================",
        "  pre-commit hook — COMMIT BLOCKED (territory mix)",
        "================================================================",
        "",
        "This commit's staged paths span MULTIPLE agents' exclusive",
        "territories. That means it's about to ship another agent's",
        "in-progress work alongside yours. Unstage what isn't yours, or",
        "split into separate path-scoped commits.",
        "",
        "Staged paths by owner:",
        "",
    ]
    for owner in sorted(by_owner.keys()):
        msg.append(f"  [{owner}]")
        for path in sorted(by_owner[owner]):
            msg.append(f"    {path}")
        msg.append("")

    msg.extend(
        [
            "Fix by either:",
            "",
            "  1. Unstaging the paths that aren't yours:",
            "       git restore --staged <path1> <path2> ...",
            "",
            "  2. Re-running with explicit path-scoping:",
            '       git commit -m "..." -- <your path 1> <your path 2> ...',
            "",
            "================================================================",
            "",
        ]
    )
    sys.stderr.write("\n".join(msg))
    return 1


if __name__ == "__main__":
    sys.exit(main())
