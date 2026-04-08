# review

A [pi](https://github.com/mariozechner/pi-coding-agent) extension that runs an automated code review loop between two AI models. One model reviews your code. Another fixes the issues. They repeat until the reviewer approves.

Both agents run as normal turns in your pi session. You see everything — every file read, every edit, every verdict. Press ESC to pause either agent and steer it.

## Why

Code review by a single model is shallow. The reviewer finds problems but can't verify fixes. The fixer makes changes but can't judge their quality. This extension closes the loop: the reviewer re-examines the fixer's work, catches regressions, and only approves when the code is right.

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

The reviewer model examines your code, lists blocking issues and nitpicks, then gives a verdict. If changes are requested, the fixer model addresses each issue. The reviewer re-examines. The loop continues until approved or max rounds reached.

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

**Fresh** (default) — Each round, the reviewer starts with clean context. It re-reads all files from disk, gets the full review rules, and sees a summary of prior fixes. This produces a holistic re-review every round. Context cost stays constant.

**Incremental** — The reviewer keeps its context across rounds. Round 2+ receives a short re-review prompt instead of the full rules. Cheaper per round, but the reviewer may focus narrowly on its prior feedback.

Change the mode with `/review:cfg` or set it in `~/.pi/agent/review.json`.

### @path context injection

Pass files or directories to give both reviewer and fixer extra context:

```
/review @docs/api-spec.md @internal/auth/ check the OAuth flow
```

Files are re-read from disk before each prompt. Edit a file between rounds and the next reviewer or fixer sees the updated content.

### Git-aware fixes

The fixer follows strict git rules based on your repo state:

- **Uncommitted changes** — Leaves changes uncommitted. No new commits.
- **Single commit** — Amends with `--no-edit`.
- **Multiple commits** — Creates `--fixup` commits per SHA, then runs `git rebase -i --autosquash`.
- **Split requests** — Uses interactive rebase with `edit` to split commits.

### Interactive editor protection

During the review loop, the extension blocks interactive editors (`vim`, `vi`, `nano`) from opening. If the fixer runs a git command that would open an editor, it gets an error message explaining how to use non-interactive alternatives instead. No more stuck sessions.

### Steering

Press **ESC** while either agent is working. The agent pauses. Type your guidance and press Enter. The agent continues with your direction. The loop resumes automatically after the agent finishes.

### Resume

If you restart pi or reload extensions, run `/review:resume`. It reconstructs the loop state from your session history and picks up where it left off.

## Configuration

Settings live in `~/.pi/agent/review.json` (separate from pi's `settings.json` to avoid conflicts). Edit directly or use `/review:cfg`.

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

The extension reads `enabledModels` from pi's `settings.json` for the model picker in `/review:cfg`.

## License

MIT
