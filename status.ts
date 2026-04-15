/**
 * Status — timing utilities and elapsed-time tracking.
 */

export function formatDuration(ms: number): string {
	const s = Math.floor(ms / 1000);
	const m = Math.floor(s / 60);
	const h = Math.floor(m / 60);
	if (h > 0) return `${h}h ${m % 60}m`;
	if (m > 0) return `${m}m ${s % 60}s`;
	return `${s}s`;
}

export function formatTime(ts: number): string {
	return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

export interface Status {
	start(): void;
	stop(): void;
	pause(): void;
	resume(): void;
	elapsed(): number;
}

export function createStatus(): Status {
	let startedAt = 0;
	let pauseStartedAt = 0;
	let totalPaused = 0;

	return {
		start() {
			startedAt = Date.now();
			pauseStartedAt = 0;
			totalPaused = 0;
		},
		stop() {
			startedAt = 0;
			pauseStartedAt = 0;
			totalPaused = 0;
		},
		pause() {
			if (pauseStartedAt === 0) pauseStartedAt = Date.now();
		},
		resume() {
			if (pauseStartedAt > 0) {
				totalPaused += Date.now() - pauseStartedAt;
				pauseStartedAt = 0;
			}
		},
		elapsed() {
			if (!startedAt) return 0;
			return Date.now() - startedAt - totalPaused;
		},
	};
}
