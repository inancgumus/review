export type LoopMode = "review" | "exec" | "manual";

export type ReviewMode = "fresh" | "incremental";

export type Verdict = "approved" | "changes_requested" | null;

export interface RoundResult {
	round: number;
	verdict: Verdict;
	overseerText: string;
	workhorseSummary: string;
	startedAt: number;
	endedAt: number;
	workhorseStartedAt: number;
}

export interface LoopState {
	mode: LoopMode;
	phase: "idle" | "reviewing" | "fixing" | "awaiting_feedback";
	round: number;
	focus: string;
	initialRequest: string;
	contextPaths: string[];
	maxRounds: number;
	reviewMode: ReviewMode;
	originalModelStr: string;
	originalThinking: string;
	overseerLeafId: string | null;
	anchorEntryId: string | null;
	workhorseSummaries: string[];
	roundResults: RoundResult[];
	patchSnapshot: Map<string, string> | null;
	snapshotBase: string;
	taggedSubjects: string[];
	unchangedCommits: string[];
	contextHashes: Map<string, string> | null;
	changedContextPaths: string[];
	loopStartedAt: number;
	roundStartedAt: number;
	// Manual mode
	commitList: string[];
	currentCommitIdx: number;
	userFeedback: string;
	manualInnerRound: number;
	manualBase: string;
	pausedElapsed: number;
	hasPlannotator: boolean | null;
}

export function newState(overrides: Partial<LoopState> = {}): LoopState {
	return {
		mode: "review",
		phase: "idle",
		round: 0,
		focus: "",
		initialRequest: "",
		contextPaths: [],
		maxRounds: 10,
		reviewMode: "fresh",
		originalModelStr: "",
		originalThinking: "xhigh",
		overseerLeafId: null,
		anchorEntryId: null,
		workhorseSummaries: [],
		roundResults: [],
		patchSnapshot: null,
		snapshotBase: "",
		taggedSubjects: [],
		unchangedCommits: [],
		contextHashes: null,
		changedContextPaths: [],
		loopStartedAt: 0,
		roundStartedAt: 0,
		commitList: [],
		currentCommitIdx: 0,
		userFeedback: "",
		manualInnerRound: 0,
		manualBase: "",
		pausedElapsed: 0,
		hasPlannotator: null,
		...overrides,
	};
}
