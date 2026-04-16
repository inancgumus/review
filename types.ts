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

export interface LogSnapshot {
	initialRequest: string;
	roundResults: RoundResult[];
	loopStartedAt: number;
}

export interface Mode {
	start(args: string, ctx: any): Promise<void>;
	resume(ctx: any, anchor: { id: string; data: any }): Promise<void>;
	stop(ctx: any): Promise<void>;
	isRunning(): boolean;
	getMaxRounds(): number;
	setMaxRounds(n: number): void;
	logSnapshot(): LogSnapshot | null;
}


