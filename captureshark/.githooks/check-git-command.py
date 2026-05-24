#!/usr/bin/env python3
"""Claude Code PreToolUse hook — blocks unsafe git operations.

The repo currently has two Claude agents working on the same `main`
branch in the same working tree (queue/PWA + photo). The git index is
a shared resource: a bare `git commit` captures whatever happens to be
staged at the moment, including the other agent's in-progress work.

This hook intercepts every Bash call. For `git commit` and `git add`,
it enforces the two rules that mechanically prevent cross-agent
contamination:

  1. `git commit` MUST be path-scoped (`commit ... -- <paths>`).
  2. `git add` MUST list explicit paths — no `.`, `-A`, `--all`, `-u`.

Anything else is allowed through. The companion pre-commit hook (in
`.git/hooks/pre-commit`) provides defence in depth at the git layer.
"""

import json
import re
import sys


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        # Malformed input — don't block on it; the harness will retry.
        return 0

    command = (payload.get("tool_input") or {}).get("command", "")
    if not isinstance(command, str):
        return 0
    command = command.strip()
    if not command:
        return 0

    # Only inspect git commands; everything else passes.
    if "git " not in command and not command.startswith("git "):
        return 0

    # --- Rule 1: `git commit` must be path-scoped ----------------------
    # Match `git commit` anywhere in the command (e.g. after `&&` /
    # `;`), but ignore `git commit-tree` and similar plumbing.
    commit_re = re.compile(r"\bgit\s+commit\b(?!-)")
    for match in commit_re.finditer(command):
        # Everything from this `git commit` onwards in this command.
        tail = command[match.start() :]
        # Cut off at the next pipeline separator, so we only inspect
        # this one git command.
        tail = re.split(r"(?:\|\||&&|;|\|)\s", tail, maxsplit=1)[0]
        # Path-scoped form: ` -- ` token followed by at least one
        # non-flag argument. Anything else is rejected.
        if not re.search(r"\s--\s+\S", tail):
            sys.stderr.write(
                "\n"
                "================================================================\n"
                "  BLOCKED by Claude Code hook — bare `git commit` is unsafe\n"
                "================================================================\n"
                "\n"
                "Two agents share this working tree's git index. A `git commit`\n"
                "without path-scoping captures whatever happens to be staged at\n"
                "the moment, including the OTHER agent's in-progress work.\n"
                "\n"
                "Use path-scoping:\n"
                "\n"
                "    git commit -m \"...\" -- <your path 1> <your path 2> ...\n"
                "\n"
                "If you genuinely need a bare commit, run it outside Claude.\n"
                "================================================================\n"
                "\n"
            )
            return 2

    # --- Rule 2: `git add` must list explicit paths --------------------
    # `git add .`, `git add -A`, `git add --all`, `git add -u`
    broad_add_re = re.compile(
        r"\bgit\s+add\s+(?:\.|-A|--all|-u|--update)(?:\s|$)"
    )
    if broad_add_re.search(command):
        sys.stderr.write(
            "\n"
            "================================================================\n"
            "  BLOCKED by Claude Code hook — broad `git add` is unsafe\n"
            "================================================================\n"
            "\n"
            "`git add .` / `-A` / `--all` / `-u` sweeps whatever the OTHER\n"
            "agent has modified into the index. List paths explicitly:\n"
            "\n"
            "    git add path/to/file1 path/to/file2 ...\n"
            "\n"
            "================================================================\n"
            "\n"
        )
        return 2

    return 0


if __name__ == "__main__":
    sys.exit(main())
