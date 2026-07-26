import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
	formatPlannerCompactFailure,
	formatPlannerCompactSkipped,
	isPlannerCompactConcurrencyError,
	isPlannerCompactionInFlight,
	isPlannerCompactNothingToCompactError,
	isPlannerCompactTimeoutError,
	markPlannerCompactionInFlight,
	markPlannerControlledCompactStarted,
	PLANNER_COMPACT_MARKER,
	PLANNER_SYSTEM_INSTRUCTIONS_HEADER,
	shouldCancelOverlappingCompaction,
	shouldClearStaleCompactIndicator,
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
