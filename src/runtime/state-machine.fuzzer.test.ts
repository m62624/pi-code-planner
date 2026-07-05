import { describe, expect, it } from "vitest";
import {
	createInitialPlanState,
	PLANNER_STAGE_STEPS,
	type PlanCreationMethod,
	type PlannerStage,
	type PlannerStep,
	type PlanStateRecord,
} from "../storage/schema";
import {
	enterPlannerRecovery,
	finishPlannerStep,
	getAllowedNextPlannerPositions,
	type PlannerPosition,
	resumePlannerAfterRecovery,
	startPlannerStep,
} from "./state-machine";

// Exhaustive model-checker over the planner transition graph. Instead of
// hand-picking a few flows, it enumerates EVERY (stage, step) the schema
// declares and walks the real getAllowedNextPlannerPositions edges to prove
// global properties: reachability, deadlock-freedom, and edge validity — for
// both creation methods. New states/steps are covered automatically; anything
// unreachable or dead-ended fails the test with the exact offending state.

const CREATION_METHODS: PlanCreationMethod[] = ["create", "improve"];
const START: PlannerPosition = { stage: "init", step: "check_project" };

// The only states allowed to have zero outgoing graph edges.
// - done/cleanup_plan_files: the true terminal (plan complete).
// - recovery/repair_or_resume: exits via resumePlannerAfterRecovery, a special
//   edge outside the normal advance graph (covered by its own test below).
const TERMINAL = key({ stage: "done", step: "cleanup_plan_files" });
const RECOVERY_EXIT = key({ stage: "recovery", step: "repair_or_resume" });
const ZERO_SUCCESSOR_ALLOWED = new Set([TERMINAL, RECOVERY_EXIT]);

function key(pos: PlannerPosition): string {
	return `${pos.stage}/${pos.step}`;
}

function allStates(): PlannerPosition[] {
	const states: PlannerPosition[] = [];
	for (const [stage, steps] of Object.entries(PLANNER_STAGE_STEPS)) {
		for (const step of steps) {
			states.push({ stage: stage as PlannerStage, step: step as PlannerStep });
		}
	}
	return states;
}

function successors(
	pos: PlannerPosition,
	creationMethod: PlanCreationMethod,
): PlannerPosition[] {
	return getAllowedNextPlannerPositions({ ...pos, creationMethod });
}

function reachableFrom(
	seeds: PlannerPosition[],
	creationMethod: PlanCreationMethod,
): Set<string> {
	const seen = new Set<string>(seeds.map(key));
	const queue = [...seeds];
	while (queue.length > 0) {
		const current = queue.shift();
		if (!current) break;
		for (const next of successors(current, creationMethod)) {
			if (!seen.has(key(next))) {
				seen.add(key(next));
				queue.push(next);
			}
		}
	}
	return seen;
}

describe("planner state machine model-checker", () => {
	const states = allStates();
	// Recovery is entered via enterPlannerRecovery from any state, so seed BFS
	// with the recovery entry point as well as the lifecycle start.
	const seeds: PlannerPosition[] = [
		START,
		{ stage: "recovery", step: "read_state" },
	];

	it("declares a non-trivial state space", () => {
		// Sanity: if this number ever drops unexpectedly, steps were removed.
		expect(states.length).toBeGreaterThanOrEqual(40);
	});

	it("every state is reachable from the start (+ recovery entry)", () => {
		const reachableUnion = new Set<string>();
		for (const method of CREATION_METHODS) {
			for (const k of reachableFrom(seeds, method)) reachableUnion.add(k);
		}
		const unreachable = states.map(key).filter((k) => !reachableUnion.has(k));
		expect(unreachable).toEqual([]);
	});

	it("has no structural deadlock — every non-terminal state can advance", () => {
		// A state is a deadlock only if it has zero successors under its plan's
		// creation method (a real plan has one fixed method).
		for (const method of CREATION_METHODS) {
			const reachable = reachableFrom(seeds, method);
			const deadEnds: string[] = [];
			for (const state of states) {
				if (!reachable.has(key(state))) continue;
				if (ZERO_SUCCESSOR_ALLOWED.has(key(state))) continue;
				if (successors(state, method).length === 0) {
					deadEnds.push(`${key(state)} (creationMethod=${method})`);
				}
			}
			expect(deadEnds).toEqual([]);
		}
	});

	it("only the declared terminal and recovery-exit have zero successors", () => {
		const zeroSuccessor = new Set<string>();
		for (const state of states) {
			const total = CREATION_METHODS.reduce(
				(sum, method) => sum + successors(state, method).length,
				0,
			);
			if (total === 0) zeroSuccessor.add(key(state));
		}
		expect([...zeroSuccessor].sort()).toEqual(
			[...ZERO_SUCCESSOR_ALLOWED].sort(),
		);
	});

	it("never advances to a non-existent state", () => {
		const valid = new Set(states.map(key));
		const badEdges: string[] = [];
		for (const method of CREATION_METHODS) {
			for (const state of states) {
				for (const next of successors(state, method)) {
					if (!valid.has(key(next))) {
						badEdges.push(`${key(state)} -> ${key(next)}`);
					}
				}
			}
		}
		expect(badEdges).toEqual([]);
	});

	it("reports coverage (visible in test output)", () => {
		const reachableUnion = new Set<string>();
		for (const method of CREATION_METHODS) {
			for (const k of reachableFrom(seeds, method)) reachableUnion.add(k);
		}
		// Surfaces the verified state count + terminals so a human reviewing the
		// run can see exactly what was covered.
		console.log(
			`[model-checker] states=${states.length} reachable=${reachableUnion.size} ` +
				`terminal=${TERMINAL} recovery-exit=${RECOVERY_EXIT}`,
		);
		expect(reachableUnion.size).toBe(states.length);
	});
});

// Global ordering used to always pick the forward branch at decision points,
// so the simulation drives toward done instead of looping (e.g. change request).
const STAGE_ORDER: PlannerStage[] = [
	"init",
	"intake",
	"discovery",
	"spec",
	"planning",
	"execution",
	"finalize",
	"done",
];

function globalOrder(pos: PlannerPosition): number {
	const stageIndex = STAGE_ORDER.indexOf(pos.stage);
	const steps = PLANNER_STAGE_STEPS[pos.stage] as readonly string[];
	return stageIndex * 100 + steps.indexOf(pos.step);
}

function forwardSuccessor(state: PlanStateRecord): PlannerPosition | null {
	const allowed = getAllowedNextPlannerPositions(state);
	if (allowed.length === 0) return null;
	return allowed.reduce((best, candidate) =>
		globalOrder(candidate) > globalOrder(best) ? candidate : best,
	);
}

function newPlan(creationMethod: PlanCreationMethod): PlanStateRecord {
	return {
		...createInitialPlanState({ baseBranch: "main", planBranch: "plan/p" }),
		creationMethod,
	};
}

describe("planner lifecycle simulation (real transition functions)", () => {
	for (const method of CREATION_METHODS) {
		it(`drives init -> done end to end (creationMethod=${method})`, () => {
			let state = startPlannerStep(newPlan(method));
			const visited: string[] = [key(state)];
			for (let i = 0; i < 200; i += 1) {
				const next = forwardSuccessor(state);
				if (!next) break;
				// finishPlannerStep runs complete -> advance -> start-next, the exact
				// chain the runtime uses; any illegal transition throws here.
				state = finishPlannerStep(state, { next });
				visited.push(key(state));
			}
			// The terminal step is reached and auto-started by finishPlannerStep;
			// there is no further transition, which is the intended end state.
			expect(key(state)).toBe(TERMINAL);
			expect(state.stepStatus).toBe("running");
			// The happy path touches every stage on the way down. The improve flow
			// runs discovery before goal drafting, so a fresh forward walk skips the
			// discovery stage — every other stage must still be visited.
			const expectedStages = STAGE_ORDER.filter(
				(stage) => method === "create" || stage !== "discovery",
			);
			for (const stage of expectedStages) {
				expect(visited.some((k) => k.startsWith(`${stage}/`))).toBe(true);
			}
		});
	}

	it("can enter recovery from a mid-plan state and resume forward", () => {
		// Walk a few steps, then simulate a fault.
		let state = startPlannerStep(newPlan("create"));
		state = finishPlannerStep(state, {
			next: forwardSuccessor(state) ?? START,
		});
		const recovered = enterPlannerRecovery(state, "simulated fault");
		expect(recovered.stage).toBe("recovery");
		expect(recovered.step).toBe("read_state");
		expect(recovered.broken).toBe(true);

		// Resume back into a concrete non-recovery step without throwing.
		const resumed = resumePlannerAfterRecovery(recovered, {
			stage: "planning",
			step: "read_context",
		});
		expect(resumed.stage).toBe("planning");
		expect(resumed.step).toBe("read_context");
		expect(resumed.broken).toBe(false);
		expect(resumed.stepStatus).toBe("pending");
	});

	it("rejects resuming recovery into an invalid target", () => {
		const recovered = enterPlannerRecovery(newPlan("create"), "fault");
		expect(() =>
			resumePlannerAfterRecovery(recovered, {
				stage: "recovery",
				step: "read_state",
			}),
		).toThrow();
	});
});
