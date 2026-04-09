# review

A [pi](https://github.com/mariozechner/pi-coding-agent) extension that loops two AI models in two modes:

- **Review mode** — One reviews your code, another fixes the issues, the reviewer checks the fixes.
- **Exec mode** — An orchestrator drip-feeds a plan to an implementer, one step at a time.

The loop runs until the reviewer/orchestrator approves. You see every file read, edit, and verdict in your pi session. Press ESC to pause either agent and steer it.

## Why

A single model reviews code but never checks if its suggestions were applied correctly. The fixer changes code but has no judge. This extension puts two models in a loop — one judges, one acts — and the loop repeats until the judge approves.

## Quick start

### Review mode

```
/review fix the authentication bug in cmd/login.go
```

The reviewer examines your code, lists blocking issues and nitpicks, then gives a verdict. On `CHANGES_REQUESTED`, the fixer addresses each issue. The reviewer re-examines. The loop repeats until `APPROVED` or max rounds.

### Exec mode

```
/review:exec implement the auth module @docs/plan.md @internal/auth/
```

The orchestrator reads the plan and codebase, then tells the implementer what to build — one step at a time. After each step, the orchestrator verifies and either assigns the next step or asks for a redo. The loop continues until all steps are done.

```
Round 1
┌──────────────────────┐       ┌──────────────────────┐
│ REVIEWER/ORCHESTRATOR│       │ FIXER/IMPLEMENTER    │
│                      │       │                      │
│ reads files          │       │ reads instructions   │
│ runs commands        │       │ edits code           │
│ finds issues / picks │       │ runs tests           │
│ next plan step       │       │ commits work         │
│                      │       │                      │
│ CHANGES_REQUESTED ───┼──────>│ FIXES_COMPLETE ──────┼───┐
└──────────────────────┘       └──────────────────────┘   │
                                                          │
Round 2                                                   │
┌──────────────────────┐                                  │
│ REVIEWER/ORCHESTRATOR│<─────────────────────────────────┘
│                      │
│ re-reads files       │  fresh: clean context + fixer summary
│ verifies work        │  re-reads @path from disk
│                      │
│ CHANGES_REQUESTED ───┼──> fixer/implementer runs again...
└──────────────────────┘

Round N
┌──────────────────────┐
│ REVIEWER/ORCHESTRATOR│
│                      │
│ all issues resolved  │
│ / all steps done     │
│                      │
│ APPROVED ────────────┼──> loop ends, original model restored
└──────────────────────┘
```

## Commands

| Command | Purpose |
|---|---|
| `/review [focus] [@path ...]` | Start review loop. Focus narrows what to review. `@path` injects file/directory contents. |
| `/review:exec [focus] [@path ...]` | Start exec loop. Orchestrator drip-feeds plan steps to implementer. Same `@path` syntax. |
| `/review:stop` | Stop the loop and restore your original model. |
| `/review:resume` | Resume after a pi restart or reload. |
| `/review:rounds <n>` | Change max rounds mid-loop. |
| `/review:log` | Open the log viewer — split entries, vim keys, search, two-panel layout. |
| `/review:debug` | Simulate a 3-round review loop and open the log viewer. Useful for testing the UI. |
| `/review:cfg` | Change reviewer model, fixer model, thinking level, max rounds, and review mode. |

## Features

### Two loop modes

**Review** (`/review`) — Code review loop. The reviewer reads code, lists issues, the fixer addresses them. Suitable for reviewing existing commits or uncommitted changes.

**Exec** (`/review:exec`) — Plan execution loop. The orchestrator reads a plan (passed as `@path` context) and the codebase, then tells the implementer what to build one step at a time. If a step is incomplete, the orchestrator reassigns it. The plan can be any format — the orchestrator LLM reads it and decides what to drip-feed.

Both modes share the same loop machinery, config, review modes, and log viewer.

### Two review modes

- **Fresh** (default) — The reviewer/orchestrator starts each round from scratch. It re-reads files from disk, gets full rules, and sees a summary of prior work. Prior rounds do not leak. Context cost stays constant.
- **Incremental** — The reviewer/orchestrator keeps its full context. Round 2+ gets a short re-check prompt. Cheaper, but risks tunnel vision.

Set via `/review:cfg` or the `review` section in `~/.pi/agent/settings.json`.

### @path context injection

Pass files or directories as extra context for both agents:

```
/review @docs/api-spec.md @internal/auth/ check the OAuth flow
/review:exec @docs/plan.md @internal/ implement the data layer
```

Files are re-read from disk before each prompt. Edit a file between rounds and the next agent sees your changes.

### Git-aware behavior

**Review mode** — The fixer follows strict git rules:

- **Uncommitted changes** — Leaves changes uncommitted. No new commits.
- **Single commit** — Amends with `--no-edit`.
- **Multiple commits** — Creates `--fixup` commits per SHA, then runs `git rebase -i --autosquash`.
- **Split requests** — Uses interactive rebase with `edit` to split commits.

**Exec mode** — The implementer creates regular commits with descriptive messages. One commit per step unless told otherwise.

### Interactive editor protection

The extension sets `GIT_EDITOR` and `EDITOR` to a blocker script during the loop. If the fixer runs `git commit` without `-m` or bare `git rebase -i`, the command fails with an error telling it to use non-interactive flags. Editors like `vim` never open. Sessions never get stuck.

### Log viewer

`/review:log` opens a floating modal with a two-panel layout: a list on the left, detail on the right.

Each round is split into separate entries — the original request, reviewer output, and fixer output — instead of one blob per round. The detail panel renders full markdown.

#### Two-panel focus

Press **Tab** to switch focus between the list and detail panels. When the list is focused, `j`/`k` move between entries. When the detail is focused, `j`/`k` scroll the content.

#### Vim keybindings

| Key | Action |
|---|---|
| `j` / `k` | Navigate entries (list) or scroll (detail) |
| `g` / `G` | Jump to first / last entry or top / bottom of detail |
| `d` / `u` | Half-page down / up (always scrolls detail) |
| `PgDn` / `PgUp` | Half-page down / up |
| `Home` / `End` | Same as `g` / `G` |
| `Tab` | Toggle focus between list and detail |
| `/` | Start search |
| `n` / `N` | Next / previous search match |
| `q` / `Esc` | Close (Esc clears search first, then closes) |

#### Search

Press `/` to enter search mode. Type your query and press **Enter** to confirm or **Esc** to cancel. Matches are highlighted across all entries — yellow for normal matches, white-on-red for the active match. `n` jumps to the next match, `N` to the previous. Jumping to a match in a different entry auto-selects it. Press **Esc** to clear the highlight before closing.

### Steering

Press **ESC** while either agent works. Type your guidance. The agent continues with your input and the loop resumes after it finishes.

### Resume

`/review:resume` reconstructs loop state from session history after a pi restart or reload.

## Install

Symlink the extension into your global pi extensions directory:

```bash
git clone https://github.com/inancgumus/review ~/.pi/agent/extensions/review
```

Pick one location — not both. Loading from two locations breaks command routing.

## Configuration

Settings live in `~/.pi/agent/settings.json` under the `review` key. Edit directly or use `/review:cfg`.

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
