/**
 * Status — timing utilities, elapsed-time tracking, and interval lifecycle.
 */

const g = globalThis as any;
if (!g.__loopIntervals) g.__loopIntervals = new Set();

/** Call once from the extension entry point on every load/reload. */
export function killGhostTimers(): void {
	for (const id of g.__loopIntervals) clearInterval(id);
	g.__loopIntervals.clear();
}

export function trackInterval(id: ReturnType<typeof setInterval>): void {
	g.__loopIntervals.add(id);
}

export function untrackInterval(id: ReturnType<typeof setInterval>): void {
	clearInterval(id);
	g.__loopIntervals.delete(id);
}

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

export interface StatusTimer {
	start(ctx: any): void;
	stop(): void;
}

export function createStatusTimer(onTick: (ctx: any) => void): StatusTimer {
	let timer: ReturnType<typeof setInterval> | null = null;
	return {
		start(ctx: any) {
			this.stop();
			onTick(ctx);
			timer = setInterval(() => onTick(ctx), 1000);
			trackInterval(timer);
			if (timer.unref) timer.unref();
		},
		stop() {
			if (timer) { untrackInterval(timer); timer = null; }
		},
	};
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
