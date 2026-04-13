export type LoopMode = "review" | "exec" | "manual";

export type ReviewMode = "fresh" | "incremental";

export interface RoundResult {
	round: number;
	verdict: "approved" | "changes_requested" | null;
	overseerText: string;
	workhorseSummary: string;
	startedAt: number;
	endedAt: number;
	workhorseStartedAt: number;
}


