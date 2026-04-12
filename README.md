# loop

A [pi](https://github.com/mariozechner/pi-coding-agent) extension that loops two AI models in three modes:

- **Review mode** — One oversees your code, another fixes the issues, the overseer checks the fixes.
- **Exec mode** — An orchestrator drip-feeds a plan to a workhorse, one step at a time.
- **Manual mode** — You review a commit, annotate issues, the workhorse fixes while the overseer verifies your exact feedback.

The loop runs until the overseer/orchestrator approves. You see every file read, edit, and verdict in your pi session. Press ESC to pause either agent and steer it.

## Why

A single model reviews code but never checks if its suggestions were applied correctly. The workhorse changes code but has no judge. This extension puts two models in a loop — one judges, one acts — and the loop repeats until the judge approves.

## Quick start

### Review mode

```
/loop fix the authentication bug in cmd/login.go
```

The overseer examines your code, lists blocking issues and nitpicks, then gives a verdict. On `CHANGES_REQUESTED`, the workhorse addresses each issue. The overseer re-examines. The loop repeats until `APPROVED` or max rounds.

### Manual review mode

```
/loop:manual                  # pick a commit from the branch
/loop:manual abc1234          # review a specific commit
```

Pick a commit (newest first, scoped to your branch). The diff opens in your `$EDITOR` for annotation — type comments on new lines below the code you're commenting on. No comments = approve. Comments become structured `file:line` feedback sent to the workhorse.

When plannotator is installed and enabled, it handles commit selection, diff display, and annotation in the browser instead.

```
You pick a commit
       │
       ▼
┌────────────────────────────────────┐
│ Diff opens in $EDITOR              │
│ (or plannotator in browser)        │
│                                    │
│ Type comments below code lines     │
│ No comments = approve              │
└──────────────┬─────────────────────┘
               │ comments found
               ▼
┌────────────────────────────────────┐
│ Workhorse fixes the commit         │
│ Overseer verifies your feedback    │
│ (automatic inner loop)             │
└──────────────┬─────────────────────┘
               │ verified
               ▼
       Loop ends
```

#### Editor annotation

The diff opens with syntax highlighting in your editor. Add comments on new lines:

```diff
 func authMiddleware(next http.HandlerFunc) http.HandlerFunc {
     token := r.Header.Get("Authorization")
+    if token == "" {
need real token validation, not just empty check
+        w.WriteHeader(401)
     }
```

- Comments reference the nearest code line above them
- Empty line before a comment starts a range (references all lines between the separator and the comment)
- No special prefix needed — the parser detects new lines by diffing the original against the edited file

### Exec mode

```
/loop:exec implement the auth module @docs/plan.md @internal/auth/
```

The orchestrator reads the plan and codebase, then tells the workhorse what to build — one step at a time. After each step, the orchestrator verifies and either assigns the next step or asks for a redo. The loop continues until all steps are done.

## Commands

| Command | Purpose |
|---|---|
| `/loop [focus] [@path ...]` | Start review loop. Focus narrows what to review. `@path` injects file/directory contents. |
| `/loop:exec [focus] [@path ...]` | Start exec loop. Orchestrator drip-feeds plan steps to workhorse. Same `@path` syntax. |
| `/loop:manual [sha]` | Manual review. Pick a commit or pass a SHA. Review in `$EDITOR` or plannotator. |
| `/loop:stop` | Stop the loop and restore your original model. |
| `/loop:resume` | Resume after a pi restart or reload. Works for all three modes. |
| `/loop:rounds <n>` | Change max rounds mid-loop. |
| `/loop:log` | Open the log viewer — split entries, vim keys, search, two-panel layout. |
| `/loop:debug` | Simulate a 3-round review loop and open the log viewer. Useful for testing the UI. |
| `/loop:cfg` | Change overseer model, workhorse model, thinking level, max rounds, loop mode, plannotator toggle. |

## Features

### Three loop modes

**Review** (`/loop`) — Code review loop. The overseer reads code, lists issues, the workhorse addresses them. Suitable for reviewing existing commits or uncommitted changes.

**Exec** (`/loop:exec`) — Plan execution loop. The orchestrator reads a plan (passed as `@path` context) and the codebase, then tells the workhorse what to build one step at a time. If a step is incomplete, the orchestrator reassigns it.

**Manual** (`/loop:manual`) — Human-in-the-loop review. You review a single commit in `$EDITOR` (or plannotator in browser), annotate issues inline, and the workhorse fixes it while the overseer verifies. The overseer only checks that the workhorse addressed your exact feedback — it never adds its own opinions. Always incremental. One commit at a time.

### Plannotator integration

When [plannotator](https://github.com/inancgumus/plannotator) is installed, `/loop:manual` with no args opens plannotator in the browser. Plannotator handles commit selection, diff display, and line-level annotation. Approve or request changes directly in the browser — feedback flows into the workhorse/overseer loop.

Disable via `/loop:cfg` → `Plannotator: disabled`, or `"plannotator": false` in settings.json.

When plannotator is disabled or not installed, the commit picker and `$EDITOR` annotation flow is used instead.

### Editor-based annotation

Without plannotator, `/loop:manual` opens the commit diff in `$EDITOR` with syntax highlighting. GUI editors (VS Code, Sublime, etc.) are detected and launched with `--wait`. The parser compares the original diff against your edited version to extract annotations with `sha:file:line` references.

### Time tracking

In manual mode, the timer only counts agent work time (inner loop). It pauses while you're reviewing in the editor or picker, and resumes when the workhorse starts. The status bar shows `⏸` when paused and `⏱` when running.

### Two execution modes

- **Fresh** (default) — The overseer starts each round from scratch. It re-reads files from disk, gets full rules, and sees a summary of prior work. Prior rounds do not leak. Context cost stays constant.
- **Incremental** — The overseer keeps its full context. Round 2+ gets a short re-check prompt. Cheaper, but risks tunnel vision.

Manual mode is always incremental. Context resets between feedback cycles (each new `/loop:manual` call starts fresh).

Set via `/loop:cfg` or the `loop` section in `~/.pi/agent/settings.json`.

### @path context injection

Pass files or directories as extra context for both agents:

```
/loop @docs/api-spec.md @internal/auth/ check the OAuth flow
/loop:exec @docs/plan.md @internal/ implement the data layer
```

Files are re-read from disk before each prompt. Edit a file between rounds and the next agent sees your changes.

### Git-aware behavior

**Review mode** — The workhorse follows strict git rules:

- **Uncommitted changes** — Leaves changes uncommitted. No new commits.
- **Single commit** — Amends with `--no-edit`.
- **Multiple commits** — Creates `--fixup` commits per SHA, then runs `git rebase -i --autosquash`.
- **Split requests** — Uses interactive rebase with `edit` to split commits.

**Exec mode** — The workhorse creates regular commits with descriptive messages. One commit per step unless told otherwise.

**Manual mode** — Same git rules as review mode. If the commit is HEAD, amends. If not HEAD, creates `--fixup` commits and autosquash rebases. No git state mangling for the review itself (no detached HEAD).

### Git state recovery

Manual mode checks for broken git state before each review: in-progress rebases, detached HEAD, dirty working tree. Stale rebases are auto-aborted. Detached HEAD is restored to the branch. Dirty tree proceeds with a warning. Cleanup also runs on `/loop:stop`.

### Interactive editor protection

The extension sets `GIT_EDITOR` and `EDITOR` to a blocker script during the loop. If the workhorse runs `git commit` without `-m` or bare `git rebase -i`, the command fails with an error telling it to use non-interactive flags. The user's original `$EDITOR` is preserved and used for diff annotation.

### Log viewer

`/loop:log` opens a floating modal with a two-panel layout: a list on the left, detail on the right.

Each round is split into separate entries — the original request, overseer output, and workhorse output — instead of one blob per round. The detail panel renders full markdown. Manual mode rounds are recorded but don't produce chat log entries (only visible in `/loop:log`).

#### Vim keybindings

| Key | Action |
|---|---|
| `j` / `k` | Navigate entries (list) or scroll (detail) |
| `g` / `G` | Jump to first / last entry or top / bottom of detail |
| `d` / `u` | Half-page down / up (always scrolls detail) |
| `Tab` | Toggle focus between list and detail |
| `/` | Start search |
| `n` / `N` | Next / previous search match |
| `q` / `Esc` | Close (Esc clears search first, then closes) |

### Steering

Press **ESC** while either agent works. Type your guidance. The agent continues with your input and the loop resumes after it finishes.

### Resume

`/loop:resume` reconstructs loop state from session history after a pi restart or reload. Works for all three modes — manual mode persists commit list, current position, and range base to the session.

## Install

```bash
git clone https://github.com/inancgumus/pi-loop ~/.pi/agent/extensions/loop
```

## Configuration

Settings live in `~/.pi/agent/settings.json` under the `loop` key. Edit directly or use `/loop:cfg`.

```json
{
  "overseerModel": "openai/gpt-5.4",
  "workhorseModel": "anthropic/claude-opus-4-6",
  "overseerThinking": "xhigh",
  "workhorseThinking": "xhigh",
  "maxRounds": 10,
  "reviewMode": "fresh",
  "plannotator": true
}
```

The model picker in `/loop:cfg` reads `enabledModels` from pi's `settings.json`.

Set `"plannotator": false` to always use the `$EDITOR` annotation flow instead of the browser.

## License

MIT
