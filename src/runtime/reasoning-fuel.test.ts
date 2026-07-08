import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../constants";
import type { TaskRecord } from "../storage/schema";
import type { SpecConstraint, SpecRecord } from "../storage/spec-store";
import {
	computeReasoningFuel,
	coverageFromLastCheck,
	type FuelLastCheck,
	frictionFromLastCheck,
	sharedTaskSurfaces,
	warrantedWebFromBranches,
	warrantedWebFromSpecConstraints,
} from "./reasoning-fuel";

function fuel(input: {
	warrantedWeb: number;
	coverage: number;
	stale?: number;
	friction?: number;
}): number | null {
	return computeReasoningFuel({
		stale: 0,
		friction: 0,
		...input,
	}).fuel;
}

describe("computeReasoningFuel — the 2×2 incentive", () => {
	it("no web, no stale, no friction ⇒ null (silent; the engine is not warranted)", () => {
		expect(fuel({ warrantedWeb: 0, coverage: 0 })).toBeNull();
	});

	it("running the engine where there is no web earns nothing (null, not 100)", () => {
		// Coverage is capped at the warranted web, so a run on a W=0 step cannot
		// manufacture credit — the anti-ritual property.
		expect(fuel({ warrantedWeb: 0, coverage: 5 })).toBeNull();
	});

	it("a web fully modeled with no stale/friction ⇒ ~100 (the quiet good path)", () => {
		expect(fuel({ warrantedWeb: 3, coverage: 3 })).toBe(100);
	});

	it("a web left entirely unmodeled ⇒ low fuel, scaled to the web ignored", () => {
		// The anti-laziness property, with a gradient: bigger ignored web bites more.
		expect(fuel({ warrantedWeb: 1, coverage: 0 })).toBe(50);
		expect(fuel({ warrantedWeb: 3, coverage: 0 })).toBe(25);
		expect(fuel({ warrantedWeb: 4, coverage: 0 })).toBe(20);
	});

	it("partial coverage lands between (a genuine gradient)", () => {
		// W=4, modeled 2 ⇒ unmet 2 ⇒ round(100*(1-2/5)) = 60.
		expect(fuel({ warrantedWeb: 4, coverage: 2 })).toBe(60);
	});
});

describe("computeReasoningFuel — stale and friction", () => {
	it("stale anchors alone drag fuel down and keep it non-null", () => {
		const result = computeReasoningFuel({
			warrantedWeb: 0,
			coverage: 0,
			stale: 2,
			friction: 0,
		});
		// round(100*(1 - 2/(0+2+0+1))) = round(33.3) = 33.
		expect(result.fuel).toBe(33);
	});

	it("friction alone drags fuel down and keeps it non-null", () => {
		expect(fuel({ warrantedWeb: 0, coverage: 0, friction: 1 })).toBe(50);
	});

	it("a fully modeled web still dips when an anchor is stale", () => {
		// W=2 covered, one stale: deficit 1 over denom (2+1+0+1)=4 ⇒ 75.
		expect(fuel({ warrantedWeb: 2, coverage: 2, stale: 1 })).toBe(75);
	});
});

describe("computeReasoningFuel — clamping and structure", () => {
	it("clamps coverage into [0, warrantedWeb] and floors negatives", () => {
		expect(fuel({ warrantedWeb: 3, coverage: 9 })).toBe(100);
		expect(fuel({ warrantedWeb: 3, coverage: -4 })).toBe(25);
	});

	it("reports the derived pieces the directive names", () => {
		const result = computeReasoningFuel({
			warrantedWeb: 4,
			coverage: 1,
			stale: 1,
			friction: 1,
		});
		expect(result.unmet).toBe(3);
		expect(result.stale).toBe(1);
		expect(result.friction).toBe(1);
		// deficit 5 over denom (4+1+1+1)=7 ⇒ round(100*(1-5/7)) = 29.
		expect(result.fuel).toBe(29);
	});

	it("truncates fractional inputs deterministically", () => {
		expect(fuel({ warrantedWeb: 3.9, coverage: 0.9 })).toBe(
			fuel({ warrantedWeb: 3, coverage: 0 }),
		);
	});
});

describe("warranted-web collectors", () => {
	it("counts declared branches", () => {
		expect(warrantedWebFromBranches([])).toBe(0);
		expect(
			warrantedWebFromBranches([
				{ id: "BR-1" },
				{ id: "BR-2" },
				{ id: "BR-3" },
			]),
		).toBe(3);
	});

	it("counts declared spec constraints", () => {
		expect(warrantedWebFromSpecConstraints(specWithConstraints(0))).toBe(0);
		expect(warrantedWebFromSpecConstraints(specWithConstraints(2))).toBe(2);
	});

	it("counts only surfaces two or more tasks share", () => {
		const tasks = [
			task("t1", ["src/a.ts", "src/b.ts"]),
			task("t2", ["src/b.ts", "src/c.ts"]),
			task("t3", ["src/c.ts"]),
		];
		// b.ts (t1,t2) and c.ts (t2,t3) are shared; a.ts is not.
		expect(sharedTaskSurfaces(tasks)).toBe(2);
	});

	it("no shared surface ⇒ no cross-task web", () => {
		const tasks = [task("t1", ["src/a.ts"]), task("t2", ["src/b.ts"])];
		expect(sharedTaskSurfaces(tasks)).toBe(0);
	});
});

describe("engagement — coverageFromLastCheck", () => {
	const base = { warrantedWeb: 3, stage: "execution", step: "contract_check" };

	it("a model-authored qualifying run on this step grants the full web", () => {
		expect(
			coverageFromLastCheck({
				...base,
				lastCheck: lastCheck({ outcome: "CONSISTENT" }),
			}),
		).toBe(3);
	});

	it("credits engagement even on a CONFLICT (honest work is not punished)", () => {
		expect(
			coverageFromLastCheck({
				...base,
				lastCheck: lastCheck({ outcome: "CONFLICT" }),
			}),
		).toBe(3);
	});

	it("a gate run is the mechanical floor, not the model's reasoning ⇒ 0", () => {
		expect(
			coverageFromLastCheck({
				...base,
				lastCheck: lastCheck({
					outcome: "CONSISTENT",
					gate: "spec_consistency",
				}),
			}),
		).toBe(0);
	});

	it("a check on a different step is stale for this one ⇒ 0", () => {
		expect(
			coverageFromLastCheck({
				...base,
				lastCheck: lastCheck({ outcome: "CONSISTENT", step: "write_tdd_plan" }),
			}),
		).toBe(0);
	});

	it("a not_applicable escape is not engagement ⇒ 0", () => {
		expect(
			coverageFromLastCheck({
				...base,
				lastCheck: lastCheck({ outcome: "not_applicable" }),
			}),
		).toBe(0);
	});

	it("no check at all ⇒ 0", () => {
		expect(coverageFromLastCheck({ ...base, lastCheck: null })).toBe(0);
	});
});

describe("friction — frictionFromLastCheck", () => {
	it("fires when a gate re-ran twice with the same verdict + source", () => {
		expect(frictionFromLastCheck(lastCheck({ repeat: 2 }))).toBe(1);
		expect(frictionFromLastCheck(lastCheck({ repeat: 5 }))).toBe(1);
	});

	it("does not fire on a first run or a single legitimate re-run", () => {
		expect(frictionFromLastCheck(lastCheck({}))).toBe(0);
		expect(frictionFromLastCheck(lastCheck({ repeat: 1 }))).toBe(0);
		expect(frictionFromLastCheck(null)).toBe(0);
	});
});

function lastCheck(overrides: Partial<FuelLastCheck>): FuelLastCheck {
	return {
		stage: "execution",
		step: "contract_check",
		outcome: "CONSISTENT",
		...overrides,
	};
}

function specWithConstraints(count: number): SpecRecord {
	const constraints: SpecConstraint[] = Array.from(
		{ length: count },
		(_, i) => ({
			id: `CON-${i + 1}`,
			statement: `constraint ${i + 1}`,
			kind: "invariant",
		}),
	);
	return {
		schemaVersion: SCHEMA_VERSION,
		requirements: [
			{
				id: "REQ-1",
				statement: "s",
				acceptance: "a",
				acceptanceAtom: "req_1_ok",
				priority: "must",
				inScope: true,
			},
		],
		nonGoals: [],
		constraints,
		assumptions: [],
	};
}

function task(taskId: string, scope: string[]): TaskRecord {
	return {
		schemaVersion: SCHEMA_VERSION,
		taskId,
		title: taskId,
		status: "pending",
		objective: "o",
		scope,
		acceptanceCriteria: [],
	};
}
