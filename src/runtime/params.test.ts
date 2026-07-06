import { describe, expect, it } from "vitest";
import { asObject, requiredString } from "./params";

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

describe("asObject", () => {
	it("returns a plain object unchanged", () => {
		const value = { a: 1 };
		expect(asObject(value)).toBe(value);
	});

	it("returns an empty record for null and undefined", () => {
		expect(asObject(null)).toEqual({});
		expect(asObject(undefined)).toEqual({});
	});

	it("returns an empty record for primitives", () => {
		expect(asObject(42)).toEqual({});
		expect(asObject("x")).toEqual({});
		expect(asObject(true)).toEqual({});
	});

	it("rejects arrays — a JSON array is never a valid record", () => {
		expect(asObject([1, 2, 3])).toEqual({});
	});
});
