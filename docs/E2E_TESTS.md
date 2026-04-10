# Loop E2E Tests

Run these in a test repo with a known bug (e.g., divide by zero in Go).

## Setup

```bash
mkdir /tmp/loop-test && cd /tmp/loop-test && git init
cat > main.go << 'EOF'
package main

import "fmt"

func divide(a, b int) int {
	return a / b
}

func main() {
	fmt.Println(divide(10, 0))
}
EOF
git add -A && git commit -m "buggy code"
```

Then open pi in `/tmp/loop-test`.

## Test 1: Full loop (oversee → workhorse → approve)

1. Run `/loop fix the divide by zero bug`
2. **Expect:** Overseer model switches, reviews code visibly in chat
3. **Expect:** Overseer finds the bug, ends with `VERDICT: CHANGES_REQUESTED`
4. **Expect:** Workhorse model switches, fixes the code visibly in chat
5. **Expect:** Overseer model switches back, re-reviews
6. **Expect:** `VERDICT: APPROVED`
7. **Expect:** Notification: `✅ Approved after N round(s)`
8. **Expect:** Original model restored

## Test 2: Context isolation — workhorse gets clean context

1. Run `/loop fix the divide by zero bug`
2. While the overseer is working, note it reads files and runs git commands
3. When the workhorse starts, check:
   - Workhorse should NOT reference any of the overseer's tool calls or file reads
   - Workhorse should only see its fix prompt (the overseer feedback)
   - Workhorse works from a clean tree branch rooted at the hidden `/loop` start anchor
4. **Verify:** The workhorse doesn't say "as I mentioned earlier" or reference prior conversation

## Test 3: Context isolation — overseer context depends on mode

**Incremental mode (`reviewMode: "incremental"`):**
1. Run `/loop fix the divide by zero bug`
2. Let round 1 complete (oversee + workhorse)
3. In round 2, the overseer should:
   - Remember what it reviewed in round 1 (file contents, tool calls)
   - See the workhorse summary: `[Workhorse Round 1] ...`
   - NOT see the workhorse's tool calls (edit, bash, read)
   - Receive a SHORT re-overseer prompt (no full rules, no `@path` re-injection)
4. **Verify:** Overseer references its own round 1 findings when re-reviewing

**Fresh mode (`reviewMode: "fresh"`, default):**
1. Run `/loop fix the divide by zero bug`
2. Let round 1 complete (oversee + workhorse)
3. In round 2, the overseer should:
   - Start from a CLEAN branch (no round 1 tool calls or reasoning)
   - Get full review rules re-injected
   - See accumulated workhorse summaries in a "Previous rounds" section
   - Re-read all `@path` files from disk (picks up changes made between rounds)
4. **Verify:** Overseer does a holistic re-review, not just checking prior fixes

## Test 4: Tree structure

**Incremental mode:**
1. Run `/loop fix the divide by zero bug`
2. Let round 1 complete
3. **Expect tree structure:**
   ```
   root
   ├→ review1_prompt → overseer_tools → VERDICT [overseer branch]
   │                                            └→ [Workhorse Round 1] summary → review2_prompt (short) → ...
   └→ fix1_prompt → workhorse_tools → workhorse_done [dead branch]
   ```
4. The workhorse's branch starts from root — no overseer messages on it
5. The overseer's branch has summaries but no workhorse tool calls

**Fresh mode (default):**
1. Same setup
2. **Expect tree structure:**
   ```
   loop-anchor
   ├→ review1_prompt (full rules + @path) → overseer_tools → VERDICT [dead branch]
   ├→ fix1_prompt → workhorse_tools → workhorse_done [dead branch]
   └→ review2_prompt (full rules + @path + "Previous rounds" + workhorse summary) → ...
   ```
3. Both overseer AND workhorse branch from the hidden `/loop` start anchor each round
4. Each overseer gets a completely fresh loop context with re-read `@path` files

## Test 5: ESC during overseer + steer

1. Run `/loop fix the divide by zero bug`
2. While the overseer is working, press **ESC**
3. **Expect:** Overseer pauses (normal pi behavior)
4. Type a message: "also check for nil pointer issues"
5. **Expect:** Overseer continues with your guidance
6. **Expect:** Overseer eventually produces a VERDICT
7. **Expect:** Loop auto-transitions to workhorse after VERDICT

## Test 6: ESC during workhorse + steer

1. Run `/loop fix the divide by zero bug`
2. Wait for overseer to finish (CHANGES_REQUESTED)
3. While the workhorse is working, press **ESC**
4. Type: "use errors.New instead of fmt.Errorf"
5. **Expect:** Workhorse continues with your guidance
6. **Expect:** After workhorse finishes, loop auto-transitions to next review round

## Test 7: Resume after pi restart

1. Run `/loop fix the divide by zero bug`
2. Let round 1 complete (oversee + workhorse done)
3. Press **ESC** before round 2 overseer starts, then quit pi (Ctrl+C)
4. Reopen pi in the same directory
5. Run `/loop:resume`
6. **Expect:** Notification: `Resuming round 2 (oversee phase)`
7. **Expect:** Loop continues

## Test 8: Resume after pi reload

Same as Test 7 but use pi reload (Ctrl+Shift+R) instead of quitting.

**Expect:** Same behavior — `/loop:resume` recovers from session history.

## Test 9: /loop:rounds mid-loop

1. Run `/loop fix the divide by zero bug`
2. After round 1, run `/loop:rounds 20`
3. **Expect:** Notification: `Max rounds → 20`
4. **Expect:** Status bar shows new total (e.g., `Round 2/20`)

Also test without args:
1. Run `/loop:rounds`
2. **Expect:** Shows current max rounds

## Test 10: /loop:stop

1. Run `/loop fix the divide by zero bug`
2. While the loop is running, run `/loop:stop`
3. **Expect:** Notification: `Review loop stopped`
4. **Expect:** Original model restored
5. **Expect:** Status bar cleared

## Test 11: /loop:cfg

1. Run `/loop:cfg`
2. **Expect:** Select menu with: Overseer model, Workhorse model, Max rounds
3. Select "Overseer model" → **Expect:** list of enabled models with current one marked ✓
4. Pick a different model → **Expect:** Notification confirming change
5. Press ESC to exit config
6. Run `/loop:cfg` again → **Expect:** new model shown

## Test 12: /loop starts fresh

1. Run a review loop, let it get to round 2
2. Run `/loop:stop`
3. Run `/loop some other focus` (NOT `/loop:resume`)
4. **Expect:** Starts from round 1 with the new focus, NOT resuming

## Test 13: Nothing to resume

1. In a fresh session (no prior review), run `/loop:resume`
2. **Expect:** Notification: `Nothing to resume. Use /loop to start.`

## Test 14: Approved = nothing to resume

1. Run a full loop until approved
2. Run `/loop:resume`
3. **Expect:** Notification: `Nothing to resume. Use /loop to start.`

## Test 15: Workhorse does not output VERDICT

1. Run a full loop
2. Check the workhorse's output in chat
3. **Expect:** No `VERDICT: APPROVED` or `VERDICT: CHANGES_REQUESTED` from the workhorse
4. The workhorse summary injected for the overseer should also have no VERDICT

## Test 16: agent_end drives transitions

1. Run `/loop fix the divide by zero bug`
2. The `/loop` command returns immediately (no blocking loop)
3. **Expect:** The overseer starts automatically
4. After VERDICT, **expect:** `agent_end` fires (all turns done), then workhorse starts
5. After workhorse completes all tools, **expect:** `agent_end` fires, then re-review starts
6. The loop is fully automated via `agent_end` events with deferred transitions
7. **Expect:** No "Agent is already processing" errors
8. **Key:** `agent_end` fires once per prompt (after ALL turns), not per API response like `turn_end`

## Test 17: Overseer VERDICT with markdown bold

1. Run `/loop fix the divide by zero bug`
2. **Expect:** Some models may output `VERDICT: **APPROVED**` with bold markers
3. **Expect:** Extension handles both `VERDICT: APPROVED` and `VERDICT: **APPROVED**`

## Test 18: Multi-turn workhorse transitions (agent_end)

1. Run `/loop` on a project with real bugs (multiple files)
2. **Expect:** Overseer finds bugs, VERDICT: CHANGES_REQUESTED
3. **Expect:** Workhorse does many tool calls (read, edit, bash) across multiple turns
4. **Expect:** Extension transitions ONLY after `agent_end` (entire agentic loop done)
5. **Expect:** No "Agent is already processing" errors
6. **Expect:** Loop auto-transitions to overseer round 2
7. **Key:** Uses `agent_end` event (fires once per prompt, after ALL turns), NOT `turn_end` (fires per API response)

**History of bugs fixed:**
- v1: `turn_end` + per-turn `workhorseTurnHadTools` → stuck on summary turn (no tools)
- v2: `turn_end` + accumulated `workhorsePhaseHadTools` → premature transition mid-tool-chain
- v3: `turn_end` + `waitForIdle()` → `ctx.waitForIdle()` doesn't exist in event handlers
- v4: `agent_end` → correct! fires once after all tools complete

## Test 19: Steer during workhorse

1. Run `/loop fix the divide by zero bug`
2. Wait for workhorse to start
3. Press ESC → workhorse pauses
4. Type: "Read main.go first, don't edit yet"
5. **Expect:** Workhorse responds to steer (reads file)
6. Type: "Now fix it using errors.New"
7. **Expect:** Workhorse does the actual fix (edit, bash, commit)
8. **Expect:** Loop auto-transitions to overseer after workhorse finishes
9. **Expect:** Overseer approves the fix

## Test 20: stopReason permutations (unit-level)

These verify the transition logic handles all ESC/steer/provider scenarios:

**Overseer phase:**
- R1: Natural finish + APPROVED → stop loop ✔
- R2: Natural finish + **APPROVED** (markdown bold) → stop loop ✔
- R3: Natural finish + CHANGES_REQUESTED → transition to workhorse ✔
- R4: Natural finish + no verdict (mid-exploration) → no transition ✔
- R5: ESC + empty text → no transition ✔
- R6: ESC + verdict in text → no transition (abort overrides) ✔

**Workhorse phase:**
- F1: stopReason=endTurn + tools → transition ✔
- F2: stopReason=end_turn + tools → transition ✔
- F3: stopReason=stop + tools → transition ✔ (providers vary)
- F4: stopReason=undefined + tools → transition ✔
- F5: stopReason=endTurn + no tools (steer response) → no transition ✔
- F6: stopReason=abort + tools → no transition ✔
- F7: ESC + empty → no transition ✔

## Test 21: Git scenario — uncommitted changes

Setup: repo with one clean commit, then modify a file without committing.

1. Run `/loop` on the uncommitted changes
2. **Expect:** Overseer finds bugs, CHANGES_REQUESTED
3. **Expect:** Workhorse edits files to fix bugs
4. **Expect:** Workhorse does NOT create any commits (HEAD unchanged)
5. **Expect:** Changes remain as modified (unstaged/staged)

## Test 22: Git scenario — single commit

Setup: repo with exactly 1 commit containing a bug.

1. Run `/loop`
2. **Expect:** Overseer tags the single commit SHA
3. **Expect:** Workhorse uses `git add -A && git commit --amend --no-edit`
4. **Expect:** Still 1 commit after, SHA changed (amended)

## Test 23: Git scenario — multiple commits (fixup + autosquash)

Setup: 3 commits, each with a bug in a different file.

1. Run `/loop fix all bugs in the last 3 commits`
2. **Expect:** Overseer tags each issue with the commit SHA that introduced it
3. **Expect:** Workhorse uses `git commit --fixup=<sha>` per fix
4. **Expect:** Workhorse runs `GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash` to squash fixups
5. **Expect:** Still 3 commits after — each fix in the right commit
6. **Expect:** `git show <sha1>` only touches math.go, `git show <sha2>` only touches data.go

## Test 24: Git scenario — oversee last N of M commits

Setup: 4 commits. First 2 are clean, last 2 have bugs.

1. Run `/loop review only the last 2 commits`
2. **Expect:** Overseer only flags issues in the last 2 commits
3. **Expect:** Overseer does NOT mention files from earlier commits
4. **Expect:** Workhorse creates fixups only for reviewed commits
5. **Expect:** Still 4 commits after — earlier commits completely untouched
6. **Expect:** Files from un-reviewed commits are byte-identical

## Test 25: Git scenario — split commit

Setup: 1 fat commit touching 2 unrelated files (math.go + greet.go).

1. Overseer asks to split the commit into atomic pieces
2. **Expect:** Workhorse uses `git rebase -i` with `edit`, `git reset HEAD~`, selective adds
3. **Expect:** Does NOT ask for confirmation — executes immediately
4. **Expect:** Now 2+ commits, each touching exactly one file
5. **Expect:** Code content unchanged — only commit structure changed

## Test 26: @path context expansion

Setup: create a test directory with files:
```bash
mkdir -p /tmp/loop-test/docs
echo 'Authentication uses JWT tokens stored in cookies.' > /tmp/loop-test/docs/auth.md
echo 'Rate limiting is set to 100 req/min per IP.' > /tmp/loop-test/docs/rate-limit.md
```

**Test 19a: directory expansion**
1. Run `/loop context: @docs/ check the auth implementation`
2. **Expect:** Overseer's prompt includes contents of `docs/auth.md` and `docs/rate-limit.md`
3. **Expect:** Focus is `context: check the auth implementation` (without the `@docs/` token)

**Test 19b: single file expansion**
1. Run `/loop @main.go fix the divide by zero bug`
2. **Expect:** Overseer's prompt includes the contents of `main.go`

**Test 19c: absolute path**
1. Run `/loop @/tmp/loop-test/docs/auth.md review this`
2. **Expect:** Overseer's prompt includes `auth.md` contents

**Test 19d: multi-line pasted input**
1. Paste:
   ```
   /loop context: @src/ @docs/

   Oversee the Go code for bugs and check docs are accurate.
   ```
2. **Expect:** Both `src/` and `docs/` contents expanded in the prompt
3. **Expect:** Focus is the remaining text

**Test 19e: invalid path**
1. Run `/loop @nonexistent/ fix bugs`
2. **Expect:** `@nonexistent/` kept as-is in focus (not expanded, no error)

**Test 19f: context passed to workhorse**
1. Run `/loop @main.go fix the divide by zero bug`
2. Let overseer complete with CHANGES_REQUESTED
3. **Expect:** Workhorse's prompt also includes `main.go` contents

## Test 27: Model switching — C → A → B → A → C

Verifies model is stored as string (not object ref) and correctly restored.

Setup:
- Model C (initial): `openai/gpt-4.1-nano`
- Model A (overseer): `openai/gpt-4.1-mini` (in `.pi/settings.json`)
- Model B (workhorse): `anthropic/claude-haiku-4-5` (in `.pi/settings.json`)

1. Start session with model C
2. Run `/loop fix the divide by zero bug`
3. **Expect:** Notification: `Saving model to restore later: openai/gpt-4.1-nano · ...`
4. **Expect:** agent_end #1 model = `openai/gpt-4.1-mini` (overseer A)
5. **Expect:** agent_end #2 model = `anthropic/claude-haiku-4-5` (workhorse B)
6. **Expect:** agent_end #3 model = `openai/gpt-4.1-mini` (overseer A, re-review)
7. **Expect:** After APPROVED, model restored to `openai/gpt-4.1-nano` (C)
8. **Expect:** Thinking level restored to original

**Automated test:** `/tmp/model-switch-test/test-switch.mjs` — 6/6 assertions pass.

**History of bugs fixed:**
- v1: `originalModel` stored as object ref → stale after `pi.setModel()` mutations → restored wrong model (claude-haiku-4-5 low)
- v2: `originalModelStr` stored as `"provider/id"` string → resolved via `findModel()` at restore time → correct

## Test 28: Model logging

1. Run `/loop fix the divide by zero bug`
2. **Expect:** `loop-log` custom message at each transition:
   - `📝 Request` followed by the original `/loop ...` command
   - `[Round 1] Overseer: openai/gpt-4.1-mini · mode: fresh`
   - `[Round 1] Workhorse: anthropic/claude-haiku-4-5`
   - `[Round 2] Overseer: openai/gpt-4.1-mini · mode: fresh`
   - `Review loop ended. Restored model: openai/gpt-4.1-nano · thinking: low`
3. **Expect:** Messages visible in TUI (`display: true`)
4. **Note:** `loop-log` custom messages do NOT fire as SDK subscription events — TUI only

## Test 29: Round 2+ prompt structure depends on mode

**Incremental mode:**
1. Run `/loop @main.go fix the divide by zero bug` (with `reviewMode: "incremental"`)
2. Let round 1 complete (oversee → workhorse)
3. Inspect round 2 overseer prompt in session:
   - **Expect:** Short prompt (~7 lines): "Re-review round 2. The workhorse addressed your previous feedback..."
   - **Expect:** NO `@path` file contents re-injected
   - **Expect:** NO full review rules repeated
   - **Expect:** Workhorse summary visible as `[Workhorse Round 1]` custom message above the prompt
4. **Expect:** Context usage significantly lower than round 1

**Fresh mode (default):**
1. Run `/loop @main.go fix the divide by zero bug` (with `reviewMode: "fresh"`)
2. Let round 1 complete (oversee → workhorse)
3. Inspect round 2 overseer prompt in session:
   - **Expect:** Full review rules re-injected ("You are a code overseer...")
   - **Expect:** `@path` file contents re-read from disk and included
   - **Expect:** "Previous rounds" section with accumulated workhorse summaries
   - **Expect:** Workhorse summary text includes "[Workhorse Round N]" prefix
4. **Expect:** Context usage is constant per round relative to the `/loop` start anchor (no loop accumulation)

## Test 30: Duplicate extension loading

If the extension is symlinked in BOTH `.pi/extensions/loop` (project) AND `~/.pi/agent/extensions/loop` (global), pi loads it twice. Commands get numbered suffixes (`review:1`, `review:2`) and `/loop` stops working.

1. Symlink extension in both locations
2. Run `/loop fix bugs`
3. **Expect (bug):** Model treats it as a regular prompt (no command found)
4. **Fix:** Only symlink in ONE location (global or project, not both)

## Test 31: @path files re-read from disk between rounds

Verifies that `@path` file content is re-read from disk on every prompt, not cached from `/loop` start.

1. Create `context.md` with content `MARKER_V1: initial.`
2. Run `/loop @context.md check for bugs in main.go`
3. **Expect:** Round 1 overseer prompt contains `MARKER_V1`
4. While the loop is running (after round 1 overseer finishes), edit `context.md` to `MARKER_V2: updated.`
5. **Expect:** The workhorse prompt and/or round 2 overseer prompt contains `MARKER_V2` (not stale `MARKER_V1`)

**Automated test:** `/tmp/loop-mode-test/test-modes.mjs` — Test 1 (2/2 assertions pass).

## Test 32: Review mode in /loop:cfg

1. Run `/loop:cfg`
2. **Expect:** Menu includes `Review mode: fresh` (or `incremental`)
3. Select "Review mode" → **Expect:** options:
   - `fresh ✔ — clean overseer each round, holistic re-review`
   - `incremental — overseer keeps context, only gets workhorse summary`
4. Pick `incremental` → **Expect:** Notification `Review mode → incremental`
5. Run `/loop:cfg` again → **Expect:** Shows `Review mode: incremental`

## Test 33: Fresh mode — verified via automated test

1. Run `/loop fix the divide by zero bug` with `reviewMode: "fresh"`
2. Let loop reach round 2
3. **Expect:** Round 2 prompt contains full rules ("You are a code overseer")
4. **Expect:** Round 2 prompt contains "Previous rounds" with workhorse summary

**Automated test:** `/tmp/loop-mode-test/test-modes.mjs` — Test 2 (2/2 assertions pass).

## Test 34: Incremental mode — verified via automated test

1. Run `/loop fix the divide by zero bug` with `reviewMode: "incremental"`
2. Let loop reach round 2
3. **Expect:** Round 2 prompt is SHORT (does NOT contain "You are a code overseer")
4. **Expect:** Round 2 prompt contains "workhorse addressed your previous feedback"

**Automated test:** `/tmp/loop-mode-test/test-modes.mjs` — Test 3 (2/2 assertions pass).

## Test 35: /loop:log modal viewer

1. Run `/loop fix the divide by zero bug`
2. Let at least one full round finish (`CHANGES_REQUESTED` → workhorse summary)
3. Run `/loop:log`
4. **Expect:** A floating modal opens (not a select menu)
5. **Expect:** The original `/loop ...` request is visible in the detail pane
6. **Expect:** Overseer output and workhorse output are both visible in the detail pane
7. **Expect:** Markdown headings render as headings, not raw `##` / `###`
8. Press **← / →** → **Expect:** Round changes without closing the modal
9. Press **↑ / ↓** → **Expect:** Current round detail scrolls
10. Press **Esc** → **Expect:** Modal closes

## Manual-only tests (need interactive TUI)

- Test 5 and 6 require pressing ESC and typing — can't be automated via SDK
- Test 8 requires pi reload (Ctrl+Shift+R)
- Test 11 requires interactive select menu
