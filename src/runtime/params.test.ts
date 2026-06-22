import { describe, expect, it } from "vitest";
import { requiredString } from "./params";

describe("requiredString", () => {
	it("returns the trimmed value", () => {
		expect(requiredString({ name: "  hi  " }, "name")).toBe("hi");
	});

	it("throws the canonical message when missing", () => {
		expect(() => requiredString({}, "name")).toThrow(
			"name must be a non-empty string.",
		);
	});

	it("throws when the value is not a string", () => {
		expect(() => requiredString({ name: 42 }, "name")).toThrow(TypeError);
	});

	it("throws when the value is blank after trimming", () => {
		expect(() => requiredString({ name: "   " }, "name")).toThrow(
			"name must be a non-empty string.",
		);
	});
});
