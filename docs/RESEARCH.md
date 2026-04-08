# Review Extension — Subagent Research

Research on how pi extensions integrate subagents, their trade-offs, and which approach fits the review loop.

## Approaches Found

### 1. In-process agentLoop (pi-amplike)

**Source:** [github.com/pasky/pi-amplike](https://github.com/pasky/pi-amplike)

- Uses `agentLoop` from `@mariozechner/pi-agent-core` in the same process
- Registered as a **tool** (`pi.registerTool`) — gets `signal` (ESC), `onUpdate` (streaming), `ctx.getSystemPrompt()` (project context)
- Fresh context per invocation (no shared history)
- `onUpdate` callback streams progress — `renderResult` displays tool calls, output, usage
- `signal.addEventListener("abort", ...)` handles ESC/Ctrl+C
- Used by both the `subagent` tool and `/btw` command
- `/btw` runs fire-and-forget (background), `subagent` tool blocks until done

**Pros:**
- In-process: shares API keys, model registry, no auth issues
- `signal` parameter gives native ESC support when registered as a tool
- `onUpdate` gives live streaming to the tool result display
- Fresh context each invocation
- `ctx.getSystemPrompt()` passes project context (AGENTS.md etc.)

**Cons:**
- Fixer's tool calls don't render as native pi tool calls — they render inside the tool's `renderResult` as formatted text lines
- Custom rendering needed (but matches what pi-amplike and official subagent both do — this IS the pi pattern)

**Key code:** `extensions/lib/subagent-core.ts` → `runSubagent()` function

### 2. Subprocess with JSON mode (official pi subagent example)

**Source:** `pi-coding-agent/examples/extensions/subagent/`

- Spawns a separate `pi` process with `--mode json -p --no-session`
- Parses JSON events from stdout (`message_end`, `tool_execution_start`, etc.)
- Registered as a tool — gets `signal` for abort (kills the subprocess)
- `renderResult` / `renderCall` for display
- Supports single, parallel, and chain execution modes

**Pros:**
- True process isolation
- Each subprocess gets its own everything
- `signal` kills the process (ESC works)

**Cons:**
- Subprocess overhead
- Manual JSON plumbing of stdout events
- Auth/API key issues possible (subprocess needs its own config)
- No native tool rendering — same custom `renderResult` pattern

### 3. Separate terminal panes (pi-teams)

**Source:** [github.com/burggraf/pi-teams](https://github.com/burggraf/pi-teams)

- Spawns real `pi` processes in tmux/iTerm2/Zellij/WezTerm panes
- Each agent gets a **fully native pi TUI** in its own terminal
- Communication via file-based messaging (inbox/outbox files)
- Shared task board for coordination

**Pros:**
- **Most native UI** — each agent has its own full pi TUI with native tool rendering, ESC, streaming
- True isolation (separate processes, separate sessions)
- User can watch any agent by switching panes
- Agents can run in parallel

**Cons:**
- Hard dependency on terminal multiplexer (tmux/iTerm2/Zellij/WezTerm)
- Complex coordination (file-based messaging, task board)
- Heavyweight — each agent is a full pi process
- Not suitable for tight automated loops (designed for team coordination)

### 4. pi-subagents (npm: pi-subagents)

**Source:** [github.com/nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents)

- Subprocess-based like the official subagent, but much more feature-rich
- Supports chains, parallel execution, async background execution, artifacts, skills, worktrees
- Uses `jiti` for async runner process
- Tool-based registration with `onUpdate` streaming and custom `renderResult`
- Can run async (detached) with widget showing progress

**Pros:**
- Very feature-rich (chains, parallel, async, artifacts, worktrees)
- Production-grade with many edge cases handled

**Cons:**
- Complex codebase (~30 files)
- Same subprocess JSON plumbing pattern
- Same custom rendering (not native tool calls in chat)

### 5. Model switching in main session (our original approach)

- Switch model → send prompt → agent works → switch back
- Everything happens in the main pi session

**Pros:**
- **Fully native UI** — tool calls render as normal pi tool calls
- **Native ESC** — it's a normal agent turn
- No subprocess, no custom rendering
- Simplest implementation

**Cons:**
- Shared context — reviewer and fixer see each other's messages
- Context fills up fast (~50-100K per round)
- Mitigated by `context` event filtering (strip fixer messages from reviewer's view)
- Session file grows (fixer messages stay even though reviewer doesn't see them)

## Decision

**pi-amplike's approach (in-process agentLoop as a tool)** is the best fit:

1. **ESC works** — tool's `signal` parameter propagates abort to `agentLoop`
2. **Streaming works** — `onUpdate` shows live progress in `renderResult`
3. **Context isolation** — fresh agentLoop per round, no shared history
4. **Project context** — `ctx.getSystemPrompt()` passes AGENTS.md to fixer
5. **No dependencies** — no tmux, no subprocess, in-process
6. **Proven pattern** — both pi-amplike and official subagent use tool registration

The fixer's tool calls render inside the tool result box (not as native pi tool calls). This is how ALL pi subagent extensions work — it's the pi-native pattern for subagent display.

## Not explored

- Using pi's `/tree` branching for context isolation (blog post: stacktoheap.com). Manual approach, no ESC handling for automated loops.
- `createAgentSession` SDK for a separate in-process session. Heavier than agentLoop, more isolation than needed.

## References

- pi extension docs: `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`
- pi-amplike subagent-core: `github.com/pasky/pi-amplike/extensions/lib/subagent-core.ts`
- Official subagent example: `pi-coding-agent/examples/extensions/subagent/`
- pi-teams: `github.com/burggraf/pi-teams`
- pi-subagents: `github.com/nicobailon/pi-subagents`
- Blog on /tree: `stacktoheap.com/blog/2026/02/26/pi-tree-context-window-management/`
