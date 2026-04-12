# loop

Coding agents generate code in a single pass. If you don't review it, the agent moves on, and bugs, missed edge cases, and style issues pile up. You can review everything yourself, but that gets old fast when the agent touches dozens of files, creating unsurmountable code slop churn.

## How loop helps

Loop puts a second model in the seat of a reviewer. It reads what the first model wrote, flags problems, and sends the work back for fixes. This repeats until the reviewer approves. You get reviewed code without doing the reviewing yourself. If you want to stay in control, you review the code and loop handles the fixes for you.

## Three modes

**Review**: Point it at code, and the reviewer finds issues while the workhorse fixes them. Hands-free.

```
/loop fix the authentication bug in cmd/login.go
```

**Exec** takes a plan and builds it step by step. Good for building something from a spec.

```
/loop:exec implement the auth module @docs/plan.md
```

**Manual** puts you in the driver's seat for full control. Pick a commit, annotate the diff in your editor (or browser with [plannotator](https://github.com/inancgumus/plannotator)), and the workhorse fixes what you flagged. The reviewer then verifies the fixes match your intent. You never touch the code yourself.

```
/loop:manual
```

## Manual review

Pick a commit. Annotate in your editor of choice. Let the loop make the changes.

```diff
func authMiddleware(next http.HandlerFunc) http.HandlerFunc {
    token := r.Header.Get("Authorization")
+   if token == "" {
need real token validation, not just empty check
+     w.WriteHeader(401)
```

No comments means you approve. Comments get parsed into `file:line` references and sent to the workhorse. The reviewer then verifies the workhorse actually addressed each point. If it didn't, it gets sent back. If [plannotator](https://github.com/inancgumus/plannotator) is installed, it handles the review in the browser instead. Disable it with `/loop:cfg` or `"plannotator": false` in settings.

## Install

```bash
git clone https://github.com/inancgumus/pi-loop ~/.pi/agent/extensions/loop
```

## License

MIT
