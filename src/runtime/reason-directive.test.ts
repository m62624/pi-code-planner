import { describe, expect, it } from "vitest";
import { renderReasoningDirective } from "./reason-directive";
import { computeReasoningFuel, type ReasoningFuel } from "./reasoning-fuel";

const CONTEXT = { webNoun: "declared branches", reasonTool: "planner_reason" };

function directive(input: {
	warrantedWeb: number;
	coverage: number;
	stale?: number;
	friction?: number;
}): string {
	const fuel = computeReasoningFuel({ stale: 0, friction: 0, ...input });
	return renderReasoningDirective(fuel, CONTEXT);
}

describe("renderReasoningDirective — the tone ladder", () => {
	it("stays silent when fuel is null (no web warrants the engine)", () => {
		expect(directive({ warrantedWeb: 0, coverage: 0 })).toBe("");
	});

	it("is quiet at ≥70 — a single fuel line, no nagging", () => {
		expect(directive({ warrantedWeb: 3, coverage: 3 })).toBe(
			"Reasoning fuel: 100",
		);
	});

	it("names the top deficit and a cheap move in the middle band (30–69)", () => {
		// W=4, covered 2 ⇒ fuel 60, unmet 2.
		const text = directive({ warrantedWeb: 4, coverage: 2 });
		expect(text.startsWith("Reasoning fuel: 60")).toBe(true);
		expect(text).toContain("2 declared branches still unmodeled");
		expect(text).toContain("planner_reason");
		// The middle band is one line, not the directing pair.
		expect(text).not.toContain("What's needed now");
	});

	it("switches to the directing tone below 30", () => {
		// W=4, covered 0 ⇒ fuel 20.
		const text = directive({ warrantedWeb: 4, coverage: 0 });
		expect(text).toContain("Reasoning fuel: 20");
		expect(text).toContain("4 declared branches still unmodeled");
		expect(text).toContain("What's needed now:");
		expect(text).toContain("What's NOT needed now:");
	});

	it("any friction forces the directing tone even above 30", () => {
		// W=2 covered 2 but friction 1 ⇒ fuel 60 (mid band by number) yet R>0.
		const text = directive({ warrantedWeb: 2, coverage: 2, friction: 1 });
		expect(text).toContain("thrash, not progress");
		expect(text).toContain("What's needed now:");
	});

	it("names a stale anchor deficit when it is the top deficit", () => {
		// W=0 but two stale anchors ⇒ fuel 33, and stale is the only (top) deficit.
		const fuel: ReasoningFuel = computeReasoningFuel({
			warrantedWeb: 0,
			coverage: 0,
			stale: 2,
			friction: 0,
		});
		expect(fuel.fuel).toBe(33);
		const text = renderReasoningDirective(fuel, CONTEXT);
		expect(text).toContain("2 stale anchors");
	});
});
