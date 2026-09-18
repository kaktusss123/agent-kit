/**
 * Shared "own delivery in flight" marker for the steering wake.
 *
 * While Main is blocked inside a blocking subagent wait, the wake polls pi's
 * pending-message queue (ctx.hasPendingMessages) and detaches when ANY user
 * message is queued. The extension's own background deliveries enqueue steer
 * messages too, via pi.sendMessage(..., { deliverAs: "steer" }) — generic
 * child events in wiring.ts, notifyCompleted / notifyNeedsInput in
 * workspace-runs.ts — and those must NOT wake a wait. Verified against pi
 * 0.85.1 such custom messages are queued straight onto the agent loop and do
 * not count into hasPendingMessages(); this marker keeps that guarantee
 * explicit and guards against a pi that starts counting them.
 *
 * Semantics (chosen race-tolerant and simple): every own sendMessage opens a
 * fresh suppression window (default 2s — generous against queue and
 * scheduling jitter); the wake's pending-check ignores pending messages
 * while a window is open. Inside the window a genuine user message wakes the
 * wait with up to one window of extra latency; a pending message older than
 * the open window's start is treated as user input. The marker is
 * process-wide because the delivery sites live in two modules serving one
 * main session.
 */

const DEFAULT_WINDOW_MS = 2000;

let windowMs = DEFAULT_WINDOW_MS;
let markedUntil = 0;

/** Call immediately before every own pi.sendMessage enqueue. */
export function markOwnDelivery(): void {
	markedUntil = Date.now() + windowMs;
}

/** True while an own delivery may still surface as a pending message. */
export function ownDeliveryInFlight(): boolean {
	return Date.now() < markedUntil;
}

/** Test seam: override the suppression window duration. */
export function setOwnDeliveryWindowMs(ms: number): void {
	windowMs = ms;
}

/** Test seam: force-expire the current window so a test starts cold. */
export function resetOwnDeliveryMark(): void {
	markedUntil = 0;
}
