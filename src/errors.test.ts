import { describe, expect, it } from "vitest";
import { errorMessage } from "./errors";

describe("errorMessage", () => {
	it("returns the message of an Error", () => {
		expect(errorMessage(new Error("boom"))).toBe("boom");
	});

	it("returns the message of an Error subclass", () => {
		class CustomError extends Error {}
		expect(errorMessage(new CustomError("nope"))).toBe("nope");
	});

	it("stringifies non-Error throwables", () => {
		expect(errorMessage("plain string")).toBe("plain string");
		expect(errorMessage(42)).toBe("42");
		expect(errorMessage(null)).toBe("null");
		expect(errorMessage(undefined)).toBe("undefined");
	});
});
