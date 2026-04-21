# loop

Coding agents generate code in a single pass. The agent moves on, bugs and missed edge cases pile up. You can review everything yourself, but that gets old fast when the agent touches dozens of files, creating unsurmountable code slop churn.

Loop puts a second model in the reviewer seat. It reads what the first model wrote, flags problems, sends the work back for fixes. Repeats until the reviewer approves. You get reviewed code without doing the reviewing yourself.

If you want to stay in control, you review the code and loop handles the fix cycle for you.

## Three modes

**Review** is hands-free. Point it at code, the overseer finds issues, the workhorse fixes them, the overseer re-checks. Runs until approved or you hit the round limit.

```
/loop fix the authentication bug in cmd/login.go
```

**Exec** takes a plan and builds it step by step. The overseer verifies each step before assigning the next. Useful when build order matters or you're working from a spec.

```
/loop:exec implement the auth module @docs/plan.md
```

**Manual** puts you in the reviewer seat. Pick a commit, annotate the diff in your `$EDITOR`, hand it off. The workhorse fixes what you flagged, the overseer verifies the fixes match your intent. You stay in control without writing code.

```
/loop:manual
/loop:manual abc1234
```

If [plannotator](https://github.com/inancgumus/plannotator) is installed, manual mode opens the review in the browser with line-level annotation. Falls back to `$EDITOR` otherwise.

## Review modes

**Fresh** re-reads everything each round. The overseer does a full holistic review, not just re-checking prior feedback. Catches more but costs more tokens.

**Incremental** keeps context from prior rounds. The overseer focuses on whether the workhorse addressed the previous feedback. Cheaper, faster.

Manual mode is always incremental. For review and exec, pick what fits via `/loop:cfg` or config.

## Patch-id audit

The overseer snapshots commit patch-ids before the workhorse runs. If a commit the overseer flagged comes back with an identical patch fingerprint, the overseer calls it out. Catches the workhorse lumping fixes into the wrong commit.

## Annotating diffs

In manual mode, the diff opens in your editor. Type comments on new lines below the code:

```diff
 func authMiddleware(next http.HandlerFunc) http.HandlerFunc {
     token := r.Header.Get("Authorization")
+    if token == "" {
need real token validation, not just empty check
+        w.WriteHeader(401)
```

No comments means you approve. Comments get parsed into `file:line` references and sent to the workhorse. The overseer verifies each point was addressed. If not, it sends the work back.

## Commands

| Command | What it does |
|---|---|
| `/loop [focus] [@path ...]` | Automatic review loop |
| `/loop:exec [focus] [@path ...]` | Plan execution loop |
| `/loop:manual [sha\|range]` | You review, AI fixes |
| `/loop:stop` | Stop and restore your model |
| `/loop:resume` | Resume manual review after restart |
| `/loop:rounds <n>` | Change max rounds |
| `/loop:log` | Browse past rounds |
| `/loop:cfg` | Settings |

## Log viewer

`/loop:log` shows past rounds with overseer verdicts and workhorse summaries. Browse what happened without scrolling through chat. Vim keys and search.

## Timing

Each round and the total loop show wall-clock duration in the status bar. Pauses when waiting for your input in manual mode.

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

## Install

```bash
git clone https://github.com/inancgumus/pi-loop ~/.pi/agent/extensions/loop
```

Requires [pi](https://github.com/mariozechner/pi-coding-agent).

## License

MIT
