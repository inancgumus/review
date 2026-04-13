/** Demo data for /loop:debug — kept separate to avoid inflating engine or index. */

import type { RoundResult } from "./types.js";
import type { Engine } from "./engine.js";
import { V_APPROVED, V_CHANGES } from "./verdicts.js";

const ROUNDS: Array<{ overseer: string; verdict: RoundResult["verdict"]; workhorse: string }> = [
	{
		overseer: "## Critical Issues\n\nRace condition in `handleConn()`, error swallowed silently, missing context propagation, missing `defer conn.Close()`.\n\n" + V_CHANGES,
		verdict: "changes_requested",
		workhorse: "Added sync.RWMutex, propagated error, threaded context, added defer conn.Close(). New tests added.",
	},
	{
		overseer: "## Improvements needed\n\nLock granularity too coarse. Deprecated error wrapping.\n\n" + V_CHANGES,
		verdict: "changes_requested",
		workhorse: "Narrowed lock scope. Switched to fmt.Errorf. Removed pkg/errors. 3.2x throughput improvement.",
	},
	{
		overseer: "## Final review\n\nAll issues resolved. Ship it.\n\n" + V_APPROVED,
		verdict: "approved",
		workhorse: "",
	},
];

export function seedDemoRounds(engine: Engine): void {
	const now = Date.now();
	const durations = [18 * 60000, 12 * 60000, 7 * 60000];
	let elapsed = 0;
	for (const d of durations) elapsed += d;

	const results: RoundResult[] = [];
	let cursor = now - elapsed;
	for (let i = 0; i < ROUNDS.length; i++) {
		const r = ROUNDS[i];
		const workhorseSummary = r.workhorse ? `[Workhorse Round ${i + 1}] ${r.workhorse}` : "";
		results.push({
			round: i + 1,
			verdict: r.verdict,
			overseerText: r.overseer,
			workhorseSummary,
			startedAt: cursor,
			endedAt: cursor + durations[i],
			workhorseStartedAt: r.workhorse ? cursor + Math.floor(durations[i] * 0.4) : 0,
		});
		cursor += durations[i];
	}

	engine.resetState({
		initialRequest: "fix race condition in connection handler @internal/server/conn.go",
		loopStartedAt: now - elapsed,
		roundResults: results,
		round: ROUNDS.length,
	});
}
