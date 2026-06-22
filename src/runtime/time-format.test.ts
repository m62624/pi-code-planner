import { describe, expect, it } from "vitest";
import { formatDuration } from "./time-format";

describe("formatDuration", () => {
	it("renders sub-minute durations in seconds", () => {
		expect(formatDuration(0)).toBe("0s");
		expect(formatDuration(42_000)).toBe("42s");
	});

	it("renders minutes with zero-padded seconds", () => {
		expect(formatDuration(5 * 60_000 + 9_000)).toBe("5m09s");
	});

	it("renders hours with zero-padded minutes", () => {
		expect(formatDuration(60 * 60_000 + 5 * 60_000)).toBe("1h05m");
	});

	it("floors sub-second milliseconds", () => {
		expect(formatDuration(1_999)).toBe("1s");
	});

	it("clamps negative input to zero", () => {
		expect(formatDuration(-5_000)).toBe("0s");
	});
});
