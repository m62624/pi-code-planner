import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	PLANNER_MAX_FLOOR_RATIO,
	PLANNER_MAX_OUTPUT_RESERVE_RATIO,
	PLANNER_MIN_FLOOR_RATIO,
	PLANNER_MIN_OUTPUT_RESERVE,
	PLANNER_TOOL_HEADROOM_RATIO,
	PLANNER_TURN_GROWTH_ALPHA,
} from "../constants";
import { syncInstructionFiles } from "../instructions/manager";
import { createInstructionPaths } from "../instructions/paths";
import {
	createPlanStoragePaths,
	createProjectStoragePaths,
} from "../storage/paths";
import { createInitialPlanState } from "../storage/schema";
import { TEST_INSTRUCTION_DEFAULTS } from "../test/instruction-defaults";
import { MockPlannerFs } from "../test/mock-fs";
import {
	buildPlannerCompactInstructionBundle,
	buildPlannerPostCompactMessage,
	clearPlannerCompactionInFlight,
	clearPlannerControlledCompact,
	collectAutoCompactInstructionSections,
	consumePlannerControlledCompact,
	createPlannerCompactRuntimeState,
	enqueuePlannerPostCompactMessage,
	estimatePlannerInstructionTokens,
	formatPlannerCompactFailure,
	formatPlannerCompactSkipped,
	isPlannerCompactConcurrencyError,
	isPlannerCompactionInFlight,
	isPlannerCompactNothingToCompactError,
	isPlannerCompactTimeoutError,
	markPlannerCompactionInFlight,
	markPlannerControlledCompactStarted,
	observeTurnGrowth,
	PLANNER_COMPACT_MARKER,
	PLANNER_SYSTEM_INSTRUCTIONS_HEADER,
	projectPlannerContextBudget,
	shouldCancelOverlappingCompaction,
	shouldClearStaleCompactIndicator,
	shouldProactivelyCompact,
} from "./compact";
import type { PlannerPreflightResult } from "./preflight";

describe("planner compact runtime", () => {
	it("tracks planner-controlled compact so the event handler can clear the marker", () => {
		const state = createPlannerCompactRuntimeState();

		expect(consumePlannerControlledCompact(state)).toBe(false);

		markPlannerControlledCompactStarted(state);

		expect(consumePlannerControlledCompact(state)).toBe(true);
		expect(consumePlannerControlledCompact(state)).toBe(false);

		markPlannerControlledCompactStarted(state);
		clearPlannerControlledCompact(state);

		expect(consumePlannerControlledCompact(state)).toBe(false);
	});

	it("builds manual compact instructions with planner state, artifacts, and section content", async () => {
		const setup = await createCompactSetup();
		const bundle = await buildPlannerCompactInstructionBundle({
			fs: setup.fs,
			projectPaths: setup.projectPaths,
			preflight: setup.preflight,
			sectionName: "manual-compact",
		});

		expect(bundle.text).toContain(PLANNER_COMPACT_MARKER);
		expect(bundle.text).toContain("- planId: plan-a");
		expect(bundle.text).toContain("- stage: execution");
		expect(bundle.text).toContain("- step: implement_task");
		expect(bundle.text).toContain(setup.planPaths.requestMd);
		expect(bundle.text).toContain(setup.planPaths.goalMd);
		expect(bundle.text).toContain(setup.planPaths.planMd);
		expect(bundle.text).toContain("Preserve task result and artifact links.");
		expect(bundle.sections).toMatchObject([{ key: "execution", found: true }]);
	});

	it("builds auto compact follow-up message that forces planner_status", async () => {
		const setup = await createCompactSetup();
		const sections = await collectAutoCompactInstructionSections({
			fs: setup.fs,
			projectPaths: setup.projectPaths,
			preflight: setup.preflight,
		});

		const message = buildPlannerPostCompactMessage({
			preflight: setup.preflight,
			sections,
		});

		expect(message).toContain(PLANNER_SYSTEM_INSTRUCTIONS_HEADER);
		expect(message.startsWith("[SYSTEM_INSTRUCTIONS]")).toBe(true);
		expect(message).toContain("Call planner_status immediately");
		expect(message).toContain("Use discovery.md as the project summary");
		expect(message).toContain("- planId: plan-a");
		expect(message).toContain("- step: implement_task");
		expect(message).toContain("Check git state before resuming.");
	});

	it("queues post-compact instructions behind pending user messages", () => {
		const calls: Array<{
			message: string;
			options?: { deliverAs: "followUp" };
		}> = [];

		expect(
			enqueuePlannerPostCompactMessage({
				message: "[SYSTEM_INSTRUCTIONS]\nCall planner_status.",
				isIdle: true,
				hasPendingMessages: true,
				sendUserMessage(message, options) {
					calls.push({ message, options });
				},
			}),
		).toBe("followUp");
		expect(calls).toEqual([
			{
				message: "[SYSTEM_INSTRUCTIONS]\nCall planner_status.",
				options: { deliverAs: "followUp" },
			},
		]);
	});

	it("queues post-compact instructions even when Pi reports idle", () => {
		const calls: Array<{
			message: string;
			options?: { deliverAs: "followUp" };
		}> = [];

		expect(
			enqueuePlannerPostCompactMessage({
				message: "[SYSTEM_INSTRUCTIONS]\nCall planner_status.",
				isIdle: true,
				hasPendingMessages: false,
				sendUserMessage(message, options) {
					calls.push({ message, options });
				},
			}),
		).toBe("followUp");
		expect(calls).toEqual([
			{
				message: "[SYSTEM_INSTRUCTIONS]\nCall planner_status.",
				options: { deliverAs: "followUp" },
			},
		]);
	});

	it("queues post-compact instructions while Pi is still processing", () => {
		const calls: Array<{
			message: string;
			options?: { deliverAs: "followUp" };
		}> = [];

		expect(
			enqueuePlannerPostCompactMessage({
				message: "[SYSTEM_INSTRUCTIONS]\nCall planner_status.",
				isIdle: false,
				hasPendingMessages: false,
				sendUserMessage(message, options) {
					calls.push({ message, options });
				},
			}),
		).toBe("followUp");
		expect(calls).toEqual([
			{
				message: "[SYSTEM_INSTRUCTIONS]\nCall planner_status.",
				options: { deliverAs: "followUp" },
			},
		]);
	});

	it("falls back to follow-up when idle state races with active processing", () => {
		const calls: Array<{
			message: string;
			options?: { deliverAs: "followUp" };
		}> = [];

		expect(
			enqueuePlannerPostCompactMessage({
				message: "[SYSTEM_INSTRUCTIONS]\nCall planner_status.",
				isIdle: true,
				hasPendingMessages: false,
				sendUserMessage(message, options) {
					if (!options) {
						throw new Error(
							'Agent is already processing. Specify streamingBehavior ("steer" or "followUp") to queue the message.',
						);
					}
					calls.push({ message, options });
				},
			}),
		).toBe("followUp");
		expect(calls).toEqual([
			{
				message: "[SYSTEM_INSTRUCTIONS]\nCall planner_status.",
				options: { deliverAs: "followUp" },
			},
		]);
	});

	it("explains how to retry a persisted compact boundary after timeout", () => {
		const error = new Error("request timed out after 300000ms");

		expect(isPlannerCompactTimeoutError(error)).toBe(true);
		expect(formatPlannerCompactFailure(error)).toContain(
			"Call planner_request_compact to retry",
		);
		expect(formatPlannerCompactFailure(error)).toContain("HTTP idle timeout");
		expect(isPlannerCompactTimeoutError(new Error("model unavailable"))).toBe(
			false,
		);
	});

	it("detects the nothing-to-compact refusal and stops advising a retry", () => {
		expect(
			isPlannerCompactNothingToCompactError(
				new Error("Nothing to compact (session too small)"),
			),
		).toBe(true);
		expect(
			isPlannerCompactNothingToCompactError(new Error("Already compacted")),
		).toBe(true);
		expect(
			isPlannerCompactNothingToCompactError(new Error("model unavailable")),
		).toBe(false);
		expect(
			isPlannerCompactNothingToCompactError(
				new Error("request timed out after 300000ms"),
			),
		).toBe(false);

		const failure = formatPlannerCompactFailure(
			new Error("Nothing to compact (session too small)"),
		);
		expect(failure).toContain("resolved automatically");
		expect(failure).not.toContain("planner_request_compact to retry");
	});

	it("detects the concurrency crash and treats it as a safe retry", () => {
		const error = new Error(
			"Cannot read properties of undefined (reading 'signal')",
		);
		expect(isPlannerCompactConcurrencyError(error)).toBe(true);
		expect(
			isPlannerCompactConcurrencyError(new Error("request timed out")),
		).toBe(false);
		const failure = formatPlannerCompactFailure(error);
		expect(failure).toContain("Two compactions ran at once");
		expect(failure).toContain("A single planner_request_compact retry is safe");
	});

	it("stops advising a retry once the boundary was resolved", () => {
		// handlePlannerCompactError resolves the boundary first; advising a retry
		// then would only earn a compact_not_required block (the session bug where
		// notify said "still pending… retry" right after resolving it).
		const failure = formatPlannerCompactFailure(
			new Error("request timed out after 300000ms"),
			{ boundaryResolved: true },
		);
		expect(failure).toContain("resolved without compacting");
		expect(failure).toContain("call planner_status");
		expect(failure).not.toContain("planner_request_compact to retry");
	});

	it("formats a skip message that points the model back to planner_status", () => {
		const message = formatPlannerCompactSkipped(
			"context below the compaction threshold",
		);
		expect(message).toContain("context below the compaction threshold");
		expect(message).toContain("planner_status");
	});

	it("tracks the compaction-in-flight flag", () => {
		const state = createPlannerCompactRuntimeState();
		expect(state.compactionInFlight).toBe(false);
		markPlannerCompactionInFlight(state);
		expect(state.compactionInFlight).toBe(true);
		clearPlannerCompactionInFlight(state);
		expect(state.compactionInFlight).toBe(false);
	});

	describe("isPlannerCompactionInFlight", () => {
		it("is true while a compaction runs and clears afterwards", () => {
			const state = createPlannerCompactRuntimeState();
			expect(isPlannerCompactionInFlight(state)).toBe(false);
			markPlannerCompactionInFlight(state);
			expect(isPlannerCompactionInFlight(state)).toBe(true);
			// The overlap guard must reopen once the run ends, so a cancel can never
			// wedge compaction shut for the rest of the session.
			clearPlannerCompactionInFlight(state);
			expect(isPlannerCompactionInFlight(state)).toBe(false);
		});

		it("is true while a planner-controlled compaction is requested", () => {
			const state = createPlannerCompactRuntimeState();
			markPlannerControlledCompactStarted(state);
			expect(isPlannerCompactionInFlight(state)).toBe(true);
			clearPlannerControlledCompact(state);
			expect(isPlannerCompactionInFlight(state)).toBe(false);
		});
	});

	describe("shouldCancelOverlappingCompaction", () => {
		it("cancels only when a plan is active and a compaction is already showing", () => {
			expect(
				shouldCancelOverlappingCompaction({
					planActive: true,
					indicatorLive: true,
				}),
			).toBe(true);
			// First compaction of the plan (nothing live yet) must proceed.
			expect(
				shouldCancelOverlappingCompaction({
					planActive: true,
					indicatorLive: false,
				}),
			).toBe(false);
			// No plan: the planner indicator is irrelevant, leave Pi's own UX alone.
			expect(
				shouldCancelOverlappingCompaction({
					planActive: false,
					indicatorLive: true,
				}),
			).toBe(false);
		});
	});

	describe("shouldClearStaleCompactIndicator", () => {
		it("clears while the interval is still live", () => {
			expect(
				shouldClearStaleCompactIndicator({
					timerLive: true,
					bannerVisible: false,
				}),
			).toBe(true);
		});

		it("clears a banner that outlived its timer (the /reload-decoupled case)", () => {
			// The regression: the closure interval was torn down (or re-created at
			// null) while the module-level banner line still showed over the resumed
			// model. Consulting the banner catches it.
			expect(
				shouldClearStaleCompactIndicator({
					timerLive: false,
					bannerVisible: true,
				}),
			).toBe(true);
		});

		it("does nothing when neither the timer nor the banner is up", () => {
			expect(
				shouldClearStaleCompactIndicator({
					timerLive: false,
					bannerVisible: false,
				}),
			).toBe(false);
		});
	});

	describe("estimatePlannerInstructionTokens", () => {
		it("mirrors Pi's conservative chars/4 heuristic", () => {
			expect(estimatePlannerInstructionTokens("")).toBe(0);
			expect(estimatePlannerInstructionTokens("a".repeat(4000))).toBe(1000);
			expect(estimatePlannerInstructionTokens("abc")).toBe(1);
		});
	});

	describe("projectPlannerContextBudget", () => {
		const knobs = {
			toolHeadroomRatio: PLANNER_TOOL_HEADROOM_RATIO,
			maxOutputReserveRatio: PLANNER_MAX_OUTPUT_RESERVE_RATIO,
			minOutputReserve: PLANNER_MIN_OUTPUT_RESERVE,
			minFloorRatio: PLANNER_MIN_FLOOR_RATIO,
			maxFloorRatio: PLANNER_MAX_FLOOR_RATIO,
		};
		// 131k window like the user's config; maxOutputTokens=32768 (clamped to
		// 25% = 32768), toolHeadroom = 131072*0.06 ≈ 7864 → floor ≈ 90440.
		const base = { ...knobs, contextWindow: 131_072, maxOutputTokens: 32_768 };

		it("reserves the model's real output budget in the floor", () => {
			const decision = projectPlannerContextBudget({ ...base, tokens: 60_000 });
			// floor sits well below the window by (outputReserve + toolHeadroom).
			expect(decision.floor).toBeLessThan(base.contextWindow - 32_768);
			expect(decision.run).toBe(false);
			expect(decision.reason).toBe("below_threshold");
		});

		it("runs once projected tokens cross the floor", () => {
			const decision = projectPlannerContextBudget({ ...base, tokens: 95_000 });
			expect(decision.run).toBe(true);
			expect(decision.reason).toBe("output_budget");
			expect(decision.headroom).toBeLessThan(0);
		});

		it("fires earlier than Pi (below Pi's window − reserveTokens floor)", () => {
			// Pi (reserveTokens 24576) would wait until tokens > 106496. Our floor is
			// lower, so at 95k we compact while Pi still would not.
			const piFloor = base.contextWindow - 24_576;
			expect(
				projectPlannerContextBudget({ ...base, tokens: 95_000 }).floor,
			).toBeLessThan(piFloor);
			expect(95_000).toBeLessThan(piFloor);
			expect(projectPlannerContextBudget({ ...base, tokens: 95_000 }).run).toBe(
				true,
			);
		});

		it("folds a pending instruction block into the projection", () => {
			const withoutPending = projectPlannerContextBudget({
				...base,
				tokens: 88_000,
			});
			const withPending = projectPlannerContextBudget({
				...base,
				tokens: 88_000,
				pendingInstructionTokens: 8_000,
			});
			expect(withoutPending.run).toBe(false);
			expect(withPending.run).toBe(true);
		});

		it("clamps the floor when the model reports maxTokens ≈ window", () => {
			const decision = projectPlannerContextBudget({
				...base,
				maxOutputTokens: 131_072,
				tokens: 70_000,
			});
			// Output reserve is capped at 25% of the window, and the floor never
			// drops below MIN_FLOOR_RATIO of the window → no thrashing.
			expect(decision.floor).toBeGreaterThanOrEqual(
				base.contextWindow * PLANNER_MIN_FLOOR_RATIO,
			);
		});

		it("self-adapts to window size (32k vs 1M give proportional floors)", () => {
			const tiny = projectPlannerContextBudget({
				...knobs,
				contextWindow: 32_768,
				maxOutputTokens: 4_096,
				tokens: 0,
			});
			const huge = projectPlannerContextBudget({
				...knobs,
				contextWindow: 1_000_000,
				maxOutputTokens: 4_096,
				tokens: 0,
			});
			expect(tiny.floor).toBeLessThan(32_768);
			expect(huge.floor).toBeGreaterThan(900_000);
			expect(tiny.floor / 32_768).toBeLessThan(huge.floor / 1_000_000);
		});

		it("does not run when tokens are unknown (post-compaction)", () => {
			expect(projectPlannerContextBudget({ ...base, tokens: null }).run).toBe(
				false,
			);
		});

		it("pre-empts one typical turn before the floor (growth margin)", () => {
			// 88k is under the ≈90.4k floor → no run on its own. But if a typical turn
			// grows the context by 5k, the next turn would cross it, so compact now.
			const idle = projectPlannerContextBudget({ ...base, tokens: 88_000 });
			expect(idle.run).toBe(false);
			const withGrowth = projectPlannerContextBudget({
				...base,
				tokens: 88_000,
				expectedGrowthTokens: 5_000,
			});
			expect(withGrowth.run).toBe(true);
			expect(withGrowth.reason).toBe("growth_margin");
			// Still-under-floor: headroom stays positive (we pre-empted, not overran).
			expect(withGrowth.headroom).toBeGreaterThan(0);
		});

		it("does not pre-empt when a typical turn stays under the floor", () => {
			const decision = projectPlannerContextBudget({
				...base,
				tokens: 70_000,
				expectedGrowthTokens: 1_000,
			});
			expect(decision.run).toBe(false);
			expect(decision.reason).toBe("below_threshold");
		});

		it("prefers output_budget over growth_margin once already over the floor", () => {
			const decision = projectPlannerContextBudget({
				...base,
				tokens: 95_000,
				expectedGrowthTokens: 5_000,
			});
			expect(decision.run).toBe(true);
			expect(decision.reason).toBe("output_budget");
		});
	});

	describe("observeTurnGrowth", () => {
		it("seeds on the first growth then folds later turns via EWMA", () => {
			const state = createPlannerCompactRuntimeState();
			// First observation only baselines (no prior tokens) — no growth yet.
			expect(observeTurnGrowth(state, 40_000, PLANNER_TURN_GROWTH_ALPHA)).toBe(
				0,
			);
			// First positive delta seeds the EWMA directly (10k).
			expect(observeTurnGrowth(state, 50_000, PLANNER_TURN_GROWTH_ALPHA)).toBe(
				10_000,
			);
			// Next delta (2k) is blended: 0.3*2000 + 0.7*10000 = 7600.
			expect(observeTurnGrowth(state, 52_000, PLANNER_TURN_GROWTH_ALPHA)).toBe(
				7_600,
			);
		});

		it("ignores a drop (a compaction reset is not turn growth) and re-baselines", () => {
			const state = createPlannerCompactRuntimeState();
			observeTurnGrowth(state, 90_000, PLANNER_TURN_GROWTH_ALPHA);
			observeTurnGrowth(state, 95_000, PLANNER_TURN_GROWTH_ALPHA); // ewma = 5000
			// A compaction drops tokens: fold nothing, keep the EWMA, re-baseline.
			expect(observeTurnGrowth(state, 30_000, PLANNER_TURN_GROWTH_ALPHA)).toBe(
				5_000,
			);
			expect(state.lastContextTokens).toBe(30_000);
			// Growth measured from the new (compacted) baseline, not the pre-drop peak.
			expect(observeTurnGrowth(state, 34_000, PLANNER_TURN_GROWTH_ALPHA)).toBe(
				0.3 * 4_000 + 0.7 * 5_000,
			);
		});

		it("is a no-op on unknown tokens", () => {
			const state = createPlannerCompactRuntimeState();
			observeTurnGrowth(state, 40_000, PLANNER_TURN_GROWTH_ALPHA);
			observeTurnGrowth(state, 50_000, PLANNER_TURN_GROWTH_ALPHA);
			const before = state.turnGrowthEwma;
			expect(observeTurnGrowth(state, null, PLANNER_TURN_GROWTH_ALPHA)).toBe(
				before,
			);
			// The baseline is untouched, so the next real turn measures from 50k.
			expect(state.lastContextTokens).toBe(50_000);
		});
	});

	describe("shouldProactivelyCompact", () => {
		const active = {
			stage: "execution" as const,
			run: true,
			compactionInFlight: false,
			requiresCompact: false,
			requiresUserDecision: false,
			broken: false,
		};

		it("compacts an active execution plan over budget", () => {
			expect(shouldProactivelyCompact(active)).toBe(true);
		});

		it("stays quiet when the budget says not to run", () => {
			expect(shouldProactivelyCompact({ ...active, run: false })).toBe(false);
		});

		it("never double-compacts while one is in flight", () => {
			expect(
				shouldProactivelyCompact({ ...active, compactionInFlight: true }),
			).toBe(false);
		});

		it("defers a pending compact boundary to the compact step", () => {
			expect(
				shouldProactivelyCompact({ ...active, requiresCompact: true }),
			).toBe(false);
		});

		it("does not disturb broken or user-decision states", () => {
			expect(shouldProactivelyCompact({ ...active, broken: true })).toBe(false);
			expect(
				shouldProactivelyCompact({ ...active, requiresUserDecision: true }),
			).toBe(false);
		});

		it("skips stages without meaningful context (init/intake/done)", () => {
			for (const stage of ["init", "intake", "done", "recovery"] as const) {
				expect(shouldProactivelyCompact({ ...active, stage })).toBe(false);
			}
		});
	});
});

async function createCompactSetup() {
	const fs = new MockPlannerFs();
	const projectPaths = createProjectStoragePaths({
		agentDir: "/agent",
		projectRoot: "/repo/app",
	});
	const planPaths = createPlanStoragePaths(projectPaths, "plan-a");
	const worktreePath = join(
		projectPaths.projectRoot,
		".pi",
		"pi-code-planner",
		"worktrees",
		"plan-a",
	);
	const state = {
		...createInitialPlanState({
			baseBranch: "main",
			planBranch: "plan/plan-a",
			worktreePath,
		}),
		stage: "execution",
		step: "implement_task",
		stepStatus: "blocked",
		activeTaskId: "task-1",
		currentBranch: "task/plan-a/task-1",
		requiresCompact: true,
	} as const;
	const preflight = {
		context: {
			status: "ready",
			activePlanId: "plan-a",
			planPaths,
			state,
		},
		decision: {
			action: "require_compact",
			reason: "Planner compact boundary is pending.",
			allowedTools: ["planner_status"],
		},
		planPaths,
		instructions: {
			keys: ["execution"],
			entries: [],
		},
	} as unknown as PlannerPreflightResult;

	await syncInstructionFiles(fs, createInstructionPaths(projectPaths), {
		...TEST_INSTRUCTION_DEFAULTS,
		execution: [
			"# execution",
			"",
			"## manual-compact",
			"Preserve task result and artifact links.",
			"",
			"## auto-compact",
			"Check git state before resuming.",
		].join("\n"),
	});

	return { fs, projectPaths, planPaths, preflight };
}
