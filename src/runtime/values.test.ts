import { describe, expect, it } from "vitest";
import { asObject } from "./values";

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
