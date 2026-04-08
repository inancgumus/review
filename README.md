# review

A [pi](https://github.com/mariozechner/pi-coding-agent) extension that loops two AI models: one reviews your code, another fixes the issues, and the reviewer checks the fixes. The loop runs until the reviewer approves.

You see every file read, edit, and verdict in your pi session. Press ESC to pause either agent and steer it.

## Why

A single model reviews code but never checks if its suggestions were applied correctly. The fixer changes code but has no judge. This extension puts a reviewer and fixer in a loop. The reviewer verifies every fix, catches regressions, and approves only when the code passes.

## Install

Symlink the extension into your global pi extensions directory:

```bash
git clone https://github.com/inancgumus/review ~/.pi/agent/extensions/review
```

Or for a specific project:

```bash
git clone https://github.com/inancgumus/review .pi/extensions/review
```

Pick one location — not both. Loading from two locations breaks command routing.

## Quick start

```
/review fix the authentication bug in cmd/login.go
```

The reviewer examines your code, lists blocking issues and nitpicks, then gives a verdict. On `CHANGES_REQUESTED`, the fixer addresses each issue. The reviewer re-examines. The loop repeats until `APPROVED` or max rounds.

## Commands

| Command | Purpose |
|---|---|
| `/review [focus] [@path ...]` | Start the loop. Focus narrows what to review. `@path` injects file/directory contents. |
| `/review:stop` | Stop the loop and restore your original model. |
| `/review:resume` | Resume after a pi restart or reload. |
| `/review:rounds <n>` | Change max rounds mid-loop. |
| `/review:log` | Browse past verdicts and fixer summaries without disturbing the loop. |
| `/review:cfg` | Change reviewer model, fixer model, thinking level, max rounds, and review mode. |

## Features

### Two review modes

**Fresh** (default) — The reviewer starts each round from scratch. It re-reads files from disk, gets full review rules, and sees a summary of prior fixes. Context cost stays constant across rounds.

**Incremental** — The reviewer keeps its full context. Round 2+ gets a short re-review prompt. Cheaper, but risks tunnel vision on prior feedback.

Set via `/review:cfg` or `~/.pi/agent/review.json`.

### @path context injection

Pass files or directories as extra context for both agents:

```
/review @docs/api-spec.md @internal/auth/ check the OAuth flow
```

Files are re-read from disk before each prompt. Edit a file between rounds and the next agent sees your changes.

### Git-aware fixes

The fixer follows strict git rules based on your repo state:

- **Uncommitted changes** — Leaves changes uncommitted. No new commits.
- **Single commit** — Amends with `--no-edit`.
- **Multiple commits** — Creates `--fixup` commits per SHA, then runs `git rebase -i --autosquash`.
- **Split requests** — Uses interactive rebase with `edit` to split commits.

### Interactive editor protection

The extension sets `GIT_EDITOR` and `EDITOR` to a blocker script during the loop. If the fixer runs `git commit` without `-m` or bare `git rebase -i`, the command fails with an error telling it to use non-interactive flags. Editors like `vim` never open. Sessions never get stuck.

### Steering

Press **ESC** while either agent works. Type your guidance. The agent continues with your input and the loop resumes after it finishes.

### Resume

`/review:resume` reconstructs loop state from session history after a pi restart or reload.

## Configuration

Settings live in `~/.pi/agent/review.json`, separate from pi's `settings.json`. Edit directly or use `/review:cfg`.

```json
{
  "reviewerModel": "openai/gpt-5.4",
  "fixerModel": "anthropic/claude-opus-4-6",
  "reviewerThinking": "xhigh",
  "fixerThinking": "xhigh",
  "maxRounds": 10,
  "reviewMode": "fresh"
}
```

The model picker in `/review:cfg` reads `enabledModels` from pi's `settings.json`.

## License

MIT
