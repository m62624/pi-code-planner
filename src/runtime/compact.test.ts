import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PLANNER_COMPACT_RESERVE_MULTIPLIER } from "../constants";
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
	decidePlannerCompactionRun,
	enqueuePlannerPostCompactMessage,
	formatPlannerCompactFailure,
	formatPlannerCompactSkipped,
	isPlannerCompactNothingToCompactError,
	isPlannerCompactTimeoutError,
	markPlannerCompactionInFlight,
	markPlannerControlledCompactStarted,
	PLANNER_COMPACT_MARKER,
	PLANNER_SYSTEM_INSTRUCTIONS_HEADER,
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
		expect(bundle.text).toContain("- step: compact_task");
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
		expect(message).toContain("- step: compact_task");
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

	describe("decidePlannerCompactionRun", () => {
		const base = {
			contextWindow: 200_000,
			reserveTokens: 16_384,
			reserveMultiplier: PLANNER_COMPACT_RESERVE_MULTIPLIER,
		};

		it("skips below the reserve-window floor", () => {
			// floor = 200000 - 16384*1.5 = 175424; well below → skip.
			expect(decidePlannerCompactionRun({ ...base, tokens: 100_000 })).toEqual({
				run: false,
				reason: "below_threshold",
			});
		});

		it("runs once tokens cross our floor", () => {
			// 180000 > 175424 → run.
			expect(decidePlannerCompactionRun({ ...base, tokens: 180_000 })).toEqual({
				run: true,
				reason: null,
			});
		});

		it("fires earlier than Pi: runs between our floor and Pi's floor", () => {
			// Pi's floor (multiplier 1) = 183616; between ours (175424) and Pi's we
			// already compact while Pi would still wait.
			const between = 180_000;
			expect(between).toBeGreaterThan(
				base.contextWindow - base.reserveTokens * base.reserveMultiplier,
			);
			expect(between).toBeLessThan(base.contextWindow - base.reserveTokens);
			expect(decidePlannerCompactionRun({ ...base, tokens: between }).run).toBe(
				true,
			);
		});

		it("scales with a tiny local window (skips a small session)", () => {
			// 32k window, floor = 32768 - 16384*1.5 = 8192; a 3k session skips.
			expect(
				decidePlannerCompactionRun({
					...base,
					contextWindow: 32_768,
					tokens: 3_000,
				}),
			).toEqual({ run: false, reason: "below_threshold" });
		});

		it("runs when tokens are unknown (lets layer B backstop)", () => {
			expect(decidePlannerCompactionRun({ ...base, tokens: null })).toEqual({
				run: true,
				reason: null,
			});
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
		step: "compact_task",
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
