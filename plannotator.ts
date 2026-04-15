/**
 * Plannotator client — owns the plannotator event/callback protocol.
 * Exposes semantic async methods so callers never see event wiring.
 */

export interface PlannotatorClient {
	isAvailable(): boolean;
	openCodeReview(cwd: string): Promise<{ approved: boolean; feedback?: string } | null>;
	reset(): void;
}

export function createPlannotator(emit: ((event: string, data: any) => void) | null): PlannotatorClient {
	let available: boolean | null = null;

	function isAvailable(): boolean {
		if (available !== null) return available;
		if (!emit) { available = false; return false; }
		let responded = false;
		emit("plannotator:request", {
			requestId: `detect-${Date.now()}`,
			action: "review-status",
			payload: { reviewId: "__loop_detect__" },
			respond: () => { responded = true; },
		});
		available = responded;
		return responded;
	}

	function openCodeReview(cwd: string): Promise<{ approved: boolean; feedback?: string } | null> {
		return new Promise((resolve) => {
			emit!("plannotator:request", {
				requestId: `loop-review-${Date.now()}`,
				action: "code-review",
				payload: { diffType: "branch", cwd },
				respond: (response: any) => {
					if (response?.status === "handled" && response.result) resolve(response.result);
					else resolve(null);
				},
			});
		});
	}

	function reset(): void {
		available = null;
	}

	return { isAvailable, openCodeReview, reset };
}
