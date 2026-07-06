import { describe, expect, it } from "vitest";
import {
	boolean,
	describeReceived,
	enumOf,
	intRange,
	nonEmptyStringArray,
	objectOf,
	optionalString,
	parseParams,
	stringArray,
	trimmedString,
} from "./param-codec";

describe("param codecs", () => {
	it("trimmedString accepts and trims, rejects blank/non-string with the received value", () => {
		expect(trimmedString().parse("  hi ")).toEqual({ ok: true, value: "hi" });
		const missing = trimmedString().parse(undefined);
		expect(missing.ok).toBe(false);
		if (!missing.ok) {
			expect(missing.error).toContain("a non-empty string");
			expect(missing.error).toContain("nothing (field missing)");
		}
		const wrong = trimmedString().parse(3);
		expect(wrong.ok).toBe(false);
		if (!wrong.ok) expect(wrong.error).toContain("a number (3)");
	});

	it("optionalString maps absent/blank to null, trims otherwise", () => {
		expect(optionalString().parse(undefined)).toEqual({
			ok: true,
			value: null,
		});
		expect(optionalString().parse("   ")).toEqual({ ok: true, value: null });
		expect(optionalString().parse(" x ")).toEqual({ ok: true, value: "x" });
		expect(optionalString().parse(5).ok).toBe(false);
	});

	it("stringArray cleans (trim, drop blank, dedupe); nonEmpty requires an entry", () => {
		expect(stringArray().parse([" a ", "a", "", "b"])).toEqual({
			ok: true,
			value: ["a", "b"],
		});
		expect(stringArray().parse(undefined)).toEqual({ ok: true, value: [] });
		const notArray = nonEmptyStringArray().parse("a");
		expect(notArray.ok).toBe(false);
		if (!notArray.ok) {
			expect(notArray.error).toContain("a non-empty array of strings");
			expect(notArray.error).toContain('a string ("a")');
		}
		const empty = nonEmptyStringArray().parse(["", "  "]);
		expect(empty.ok).toBe(false);
		if (!empty.ok) expect(empty.error).toContain("at least one");
	});

	it("enumOf, boolean and intRange validate against their domain", () => {
		expect(enumOf(["approve", "revise"] as const).parse("approve")).toEqual({
			ok: true,
			value: "approve",
		});
		const badEnum = enumOf(["approve", "revise"] as const).parse("nope");
		expect(badEnum.ok).toBe(false);
		if (!badEnum.ok) expect(badEnum.error).toContain("one of: approve, revise");
		expect(boolean().parse(true)).toEqual({ ok: true, value: true });
		expect(boolean().parse("true").ok).toBe(false);
		expect(intRange(0, 3).parse(2)).toEqual({ ok: true, value: 2 });
		expect(intRange(0, 3).parse(4).ok).toBe(false);
		expect(intRange(0, 3).parse(1.5).ok).toBe(false);
	});

	it("objectOf parses a nested schema and names the offending nested field", () => {
		const codec = objectOf({ a: intRange(0, 3), b: boolean() });
		expect(codec.parse({ a: 2, b: false })).toEqual({
			ok: true,
			value: { a: 2, b: false },
		});
		const bad = codec.parse({ a: 9, b: false });
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.error).toContain("`a`");
	});

	it("describeReceived summarizes types without dumping huge strings", () => {
		expect(describeReceived(null)).toBe("null");
		expect(describeReceived([1, 2])).toBe("an array (length 2)");
		expect(describeReceived("x".repeat(200))).toContain("…");
	});
});

describe("parseParams", () => {
	const schema = {
		title: trimmedString(),
		count: intRange(0, 3),
	};

	it("returns a typed record on success", () => {
		const result = parseParams("demo_tool", schema, { title: " T ", count: 1 });
		expect(result).toEqual({ ok: true, value: { title: "T", count: 1 } });
	});

	it("aggregates every field error into one message naming the tool and fields", () => {
		const result = parseParams("demo_tool", schema, { count: 9 });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("demo_tool: invalid arguments.");
			expect(result.error).toContain("`title`");
			expect(result.error).toContain("`count`");
			// Both failures present, not just the first.
			expect(result.error.split("\n").length).toBeGreaterThanOrEqual(3);
		}
	});
});
