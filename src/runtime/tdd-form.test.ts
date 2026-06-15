import { describe, expect, it } from "vitest";
import { mergeTddMarkdown, renderTddSection, TDD_SECTIONS } from "./tdd-form";

const PRE = TDD_SECTIONS[0];
const POST = TDD_SECTIONS[1];

const preValues = {
	failingSignal: "expect(parse()).toThrow",
	productionPath: "src/parse.ts",
	successSignal: "test passes",
	outOfScopeFiles: "src/ui/*",
};

const postValues = {
	counterexample: "empty input",
	boundaryValue: "0-length array",
	oppositeCase: "valid input still works",
	regressionRisk: "covered by existing suite",
	scopeCheck: "only src/parse.ts changed",
	action: "added guard clause",
};

describe("renderTddSection", () => {
	it("renders a heading and one bullet per field", () => {
		const block = renderTddSection(PRE, preValues);
		expect(block).toContain("## Pre-Implementation Proof Contract");
		expect(block).toContain("- failingSignal: expect(parse()).toThrow");
		expect(block).toContain("- outOfScopeFiles: src/ui/*");
	});

	it("rejects a missing field", () => {
		expect(() =>
			renderTddSection(PRE, { ...preValues, productionPath: "" }),
		).toThrow(/productionPath/);
	});

	it("rejects a placeholder value", () => {
		expect(() =>
			renderTddSection(PRE, { ...preValues, successSignal: "TODO" }),
		).toThrow(/placeholder/);
	});
});

describe("mergeTddMarkdown", () => {
	it("accumulates sections across incremental submits in canonical order", () => {
		const afterPre = mergeTddMarkdown("", {
			preImplementation: renderTddSection(PRE, preValues),
		});
		const afterPost = mergeTddMarkdown(afterPre, {
			postImplementation: renderTddSection(POST, postValues),
		});
		expect(afterPost).toContain("## Pre-Implementation Proof Contract");
		expect(afterPost).toContain("## Post-Implementation Counterexample Review");
		expect(afterPost.indexOf("Pre-Implementation")).toBeLessThan(
			afterPost.indexOf("Post-Implementation"),
		);
	});

	it("replaces an existing section instead of duplicating it", () => {
		const first = mergeTddMarkdown("", {
			preImplementation: renderTddSection(PRE, preValues),
		});
		const second = mergeTddMarkdown(first, {
			preImplementation: renderTddSection(PRE, {
				...preValues,
				failingSignal: "new signal",
			}),
		});
		expect(second.match(/## Pre-Implementation Proof Contract/g)).toHaveLength(
			1,
		);
		expect(second).toContain("- failingSignal: new signal");
	});

	it("preserves unknown sections from an external edit", () => {
		const external = "## Notes\n- hand-written note\n";
		const merged = mergeTddMarkdown(external, {
			preImplementation: renderTddSection(PRE, preValues),
		});
		expect(merged).toContain("## Notes");
		expect(merged).toContain("- hand-written note");
	});
});
