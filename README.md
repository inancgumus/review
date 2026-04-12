# loop

A [pi](https://github.com/mariozechner/pi-coding-agent) extension that loops two AI models:

- **Review** — Overseer finds issues, workhorse fixes, overseer re-checks.
- **Exec** — Orchestrator drip-feeds a plan, workhorse builds step by step.
- **Manual** — You review a commit, annotate issues, workhorse fixes while the overseer verifies your feedback.

## Quick start

### Review

```
/loop fix the authentication bug in cmd/login.go
```

### Manual review

```
/loop:manual                  # pick a commit from the branch
/loop:manual abc1234          # review a specific commit
```

The diff opens in `$EDITOR`. Type comments on new lines below the code. No comments = approve. Comments become `file:line` feedback for the workhorse.

When [plannotator](https://github.com/inancgumus/plannotator) is enabled, it handles everything in the browser instead.

```diff
 func authMiddleware(next http.HandlerFunc) http.HandlerFunc {
     token := r.Header.Get("Authorization")
+    if token == "" {
need real token validation, not just empty check
+        w.WriteHeader(401)
```

### Exec

```
/loop:exec implement the auth module @docs/plan.md @internal/auth/
```

## Commands

| Command | Purpose |
|---|---|
| `/loop [focus] [@path ...]` | Review loop |
| `/loop:exec [focus] [@path ...]` | Exec loop |
| `/loop:manual [sha]` | Manual review — pick a commit or pass a SHA |
| `/loop:stop` | Stop and restore your model |
| `/loop:resume` | Resume after restart (all modes) |
| `/loop:rounds <n>` | Change max rounds |
| `/loop:log` | Browse round logs |
| `/loop:cfg` | Settings (models, thinking, plannotator toggle) |

## Modes

**Review / Exec** — Fully automatic. Fresh mode (default) re-reads everything each round. Incremental keeps context.

**Manual** — One commit at a time. Opens `$EDITOR` for annotation (or plannotator in browser). Timer only counts agent work. No chat noise — round data in `/loop:log`. Esc on the commit picker cancels.

## Configuration

`~/.pi/agent/settings.json` under `loop`:

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

Set `"plannotator": false` to use `$EDITOR` instead of browser.

## Install

```bash
git clone https://github.com/inancgumus/pi-loop ~/.pi/agent/extensions/loop
```

## License

MIT
