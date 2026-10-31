/**
 * Unit tests for the shared own-delivery suppression marker behind the
 * steering wake: a mark opens a window that suppresses the wake's
 * pending-check, every mark refreshes it, and it expires (or is force-reset)
 * so later genuine user pending messages wake again.
 */
import { describe, test } from "node:test";
import { expect } from "../../tests/support/expect.ts";
import {
	markOwnDelivery,
	ownDeliveryInFlight,
	resetOwnDeliveryMark,
	setOwnDeliveryWindowMs,
} from "./steering-wake.ts";

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

describe("own-delivery suppression marker", () => {
	test("mark opens a window; it expires; reset force-expires", async () => {
		setOwnDeliveryWindowMs(50);
		try {
			resetOwnDeliveryMark();
			expect(ownDeliveryInFlight()).toBe(false);

			markOwnDelivery();
			expect(ownDeliveryInFlight()).toBe(true);

			await tick(70);
			expect(ownDeliveryInFlight()).toBe(false);

			// reset force-expires an open window
			markOwnDelivery();
			expect(ownDeliveryInFlight()).toBe(true);
			resetOwnDeliveryMark();
			expect(ownDeliveryInFlight()).toBe(false);
		} finally {
			setOwnDeliveryWindowMs(2000);
			resetOwnDeliveryMark();
		}
	});

	test("every mark refreshes the window (latest enqueue wins)", async () => {
		setOwnDeliveryWindowMs(60);
		try {
			resetOwnDeliveryMark();
			markOwnDelivery();
			await tick(40);
			expect(ownDeliveryInFlight()).toBe(true);
			markOwnDelivery(); // second delivery re-opens the full window
			await tick(40);
			expect(ownDeliveryInFlight()).toBe(true);
			await tick(40);
			expect(ownDeliveryInFlight()).toBe(false);
		} finally {
			setOwnDeliveryWindowMs(2000);
			resetOwnDeliveryMark();
		}
	});
});
