import { describe, expect, it } from "vitest";
import {
	createPlanStoragePaths,
	createProjectStoragePaths,
} from "../storage/paths";
import { initializePlanFiles } from "../storage/plan-store";
import { ensureProjectRecord, setActivePlan } from "../storage/project-store";
import {
	createInitialPlanState,
	createPlanRecord,
	type PlanStateRecord,
} from "../storage/schema";
import { initializePlanState, readPlanState } from "../storage/state-store";
import { MockPlannerFs } from "../test/mock-fs";
import { readActivePlanContext } from "./active-plan";
import { evaluatePlannerRuntimeReality } from "./planner-runtime";
import type { PlannerPreflightResult } from "./preflight";
import { applyPlannerStateTransition } from "./state-transition";

describe("persisted planner state transition", () => {
	it("starts a step through preflight, optional wrapper policy, state machine, and savePlanState", async () => {
		const setup = await createReadySetup({
			stepStatus: "pending",
		});

		const result = await applyPlannerStateTransition({
			fs: setup.fs,
			preflight: setup.preflight,
			tool: "planner_git_inspect",
			transition: { type: "start_step" },
		});

		expect(result).toMatchObject({ status: "applied" });
		expect(await readPlanState(setup.fs, setup.planPaths)).toMatchObject({
			stage: "init",
			step: "check_project",
			stepStatus: "running",
		});
	});

	it("blocks without saving when active context is not ready", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		await ensureProjectRecord(fs, projectPaths);
		const context = await readActivePlanContext({ fs, projectPaths });
		const preflight: PlannerPreflightResult = {
			context,
			decision: evaluatePlannerRuntimeReality({
				contextStatus: context.status,
			}),
			planPaths: null,
			memoryPaths: null,
			gitReality: null,
			memoryGate: null,
			memoryCheckpoint: null,
			instructions: null,
			worktreeExists: null,
		};

		const result = await applyPlannerStateTransition({
			fs,
			preflight,
			transition: { type: "start_step" },
		});

		expect(result).toMatchObject({
			status: "blocked",
			code: "context_not_ready",
		});
	});

	it("blocks before state machine when wrapper policy rejects the tool", async () => {
		const setup = await createReadySetup({
			stage: "execution",
			step: "write_tests",
			stepStatus: "pending",
		});

		const result = await applyPlannerStateTransition({
			fs: setup.fs,
			preflight: setup.preflight,
			tool: "planner_git_create_task_branch",
			transition: { type: "start_step" },
		});

		expect(result).toMatchObject({
			status: "blocked",
			code: "tool_blocked",
		});
		expect(await readPlanState(setup.fs, setup.planPaths)).toMatchObject({
			stepStatus: "pending",
		});
	});

	it("blocks normal transitions when runtime action is not allow_stage_machine", async () => {
		const setup = await createReadySetup({
			stepStatus: "pending",
			requiresMemoryUpdate: true,
			memoryUpdateReason: "external_commit",
		});

		const result = await applyPlannerStateTransition({
			fs: setup.fs,
			preflight: setup.preflight,
			tool: "planner_memory_scan_project",
			transition: { type: "start_step" },
		});

		expect(result).toMatchObject({
			status: "blocked",
			code: "runtime_blocked",
		});
		expect(await readPlanState(setup.fs, setup.planPaths)).toMatchObject({
			stepStatus: "pending",
			requiresMemoryUpdate: true,
		});
	});

	it("returns state machine errors without saving invalid transitions", async () => {
		const setup = await createReadySetup({
			stepStatus: "completed",
			nextStep: "index_files_iteratively",
		});

		const result = await applyPlannerStateTransition({
			fs: setup.fs,
			preflight: setup.preflight,
			transition: { type: "advance_step" },
		});

		expect(result).toMatchObject({
			status: "blocked",
			code: "state_machine_error",
			stateMachineErrorCode: "invalid_next_step",
		});
		expect(await readPlanState(setup.fs, setup.planPaths)).toMatchObject({
			step: "check_project",
			nextStep: "index_files_iteratively",
		});
	});

	it("finishes, fails, blocks, and retries with durable state", async () => {
		const setup = await createReadySetup({ stepStatus: "running" });

		expect(
			await applyPlannerStateTransition({
				fs: setup.fs,
				preflight: setup.preflight,
				transition: { type: "finish_step" },
			}),
		).toMatchObject({ status: "applied" });

		const advanced = await readPlanState(setup.fs, setup.planPaths);
		expect(advanced).toMatchObject({
			step: "check_git",
			stepStatus: "pending",
			nextStep: null,
		});

		const runningSetup = await withPreflight(setup, {
			...advanced,
			stepStatus: "running",
		});
		await applyPlannerStateTransition({
			fs: setup.fs,
			preflight: runningSetup.preflight,
			transition: { type: "fail_step", reason: "git init failed" },
		});
		const failed = await readPlanState(setup.fs, setup.planPaths);
		expect(failed).toMatchObject({
			stepStatus: "failed",
			blockedReason: "git init failed",
		});

		const retrySetup = await withPreflight(setup, failed);
		await applyPlannerStateTransition({
			fs: setup.fs,
			preflight: retrySetup.preflight,
			transition: { type: "retry_step" },
		});
		expect(await readPlanState(setup.fs, setup.planPaths)).toMatchObject({
			stepStatus: "pending",
			blockedReason: null,
		});

		const blockSetup = await withPreflight(setup, {
			...(await readPlanState(setup.fs, setup.planPaths)),
			stepStatus: "running",
		});
		await applyPlannerStateTransition({
			fs: setup.fs,
			preflight: blockSetup.preflight,
			transition: {
				type: "block_step",
				reason: "needs answer",
				requiresUserDecision: true,
			},
		});
		expect(await readPlanState(setup.fs, setup.planPaths)).toMatchObject({
			stepStatus: "blocked",
			requiresUserDecision: true,
			blockedReason: "needs answer",
		});
	});

	it("persists compact request and compact completion through the compact runtime gate", async () => {
		const setup = await createReadySetup({
			stage: "discovery",
			step: "compact_discovery",
			stepStatus: "running",
		});

		await applyPlannerStateTransition({
			fs: setup.fs,
			preflight: setup.preflight,
			transition: { type: "request_compact", reason: "compact discovery" },
		});
		const compactPending = await readPlanState(setup.fs, setup.planPaths);
		expect(compactPending).toMatchObject({
			requiresCompact: true,
			stepStatus: "blocked",
		});

		const compactSetup = await withPreflight(setup, compactPending);
		expect(compactSetup.preflight.decision.action).toBe("require_compact");
		await applyPlannerStateTransition({
			fs: setup.fs,
			preflight: compactSetup.preflight,
			transition: { type: "complete_compact" },
		});

		expect(await readPlanState(setup.fs, setup.planPaths)).toMatchObject({
			step: "enter_planning",
			stepStatus: "pending",
			nextStep: null,
			requiresCompact: false,
		});
	});

	it("persists recovery enter and resume from recovery-gated preflight", async () => {
		const setup = await createReadySetup({
			stage: "execution",
			step: "run_experiment",
			stepStatus: "running",
		});

		await applyPlannerStateTransition({
			fs: setup.fs,
			preflight: setup.preflight,
			transition: {
				type: "enter_recovery",
				reason: "wrong branch",
				requiresUserDecision: true,
			},
		});
		const recovery = await readPlanState(setup.fs, setup.planPaths);
		expect(recovery).toMatchObject({
			stage: "recovery",
			step: "read_state",
			broken: true,
			requiresUserDecision: true,
		});

		const recoverySetup = await withPreflight(setup, recovery);
		expect(recoverySetup.preflight.decision.action).toBe(
			"require_user_decision",
		);
		await applyPlannerStateTransition({
			fs: setup.fs,
			preflight: recoverySetup.preflight,
			tool: "planner_recovery_inspect",
			transition: {
				type: "resume_after_recovery",
				target: { stage: "execution", step: "run_experiment" },
			},
		});

		expect(await readPlanState(setup.fs, setup.planPaths)).toMatchObject({
			stage: "execution",
			step: "run_experiment",
			stepStatus: "pending",
			broken: false,
			requiresUserDecision: false,
		});
	});
});

interface ReadySetup {
	fs: MockPlannerFs;
	projectPaths: ReturnType<typeof createProjectStoragePaths>;
	planPaths: ReturnType<typeof createPlanStoragePaths>;
	preflight: PlannerPreflightResult;
}

async function createReadySetup(
	statePatch: Partial<PlanStateRecord> = {},
): Promise<ReadySetup> {
	const fs = new MockPlannerFs();
	const projectPaths = createProjectStoragePaths({
		agentDir: "/agent",
		projectRoot: "/repo/app",
	});
	const planPaths = createPlanStoragePaths(projectPaths, "plan-a");
	await ensureProjectRecord(fs, projectPaths);
	await initializePlanFiles(
		fs,
		planPaths,
		createPlanRecord({ planId: "plan-a", title: "Plan A" }),
	);
	await initializePlanState(fs, planPaths, buildState(statePatch));
	await setActivePlan(fs, projectPaths, "plan-a");
	return await withPreflight({ fs, projectPaths, planPaths } as ReadySetup);
}

async function withPreflight(
	setup: Pick<ReadySetup, "fs" | "projectPaths" | "planPaths">,
	state?: PlanStateRecord,
): Promise<ReadySetup> {
	if (state) {
		await initializePlanState(setup.fs, setup.planPaths, state);
	}
	const context = await readActivePlanContext({
		fs: setup.fs,
		projectPaths: setup.projectPaths,
	});
	if (context.status !== "ready") {
		throw new Error(`Expected ready context, got ${context.status}`);
	}
	const preflight: PlannerPreflightResult = {
		context,
		decision: evaluatePlannerRuntimeReality({
			contextStatus: "ready",
			state: context.state,
			git: {
				repoRoot: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
				branch: context.state.currentBranch ?? "plan/plan-a",
				headCommit: context.state.lastCheckpointCommit ?? "abc123",
				statusPorcelain: "",
				isDirty: false,
				hasConflicts: false,
			},
			memoryCheckpointValid: true,
			worktreeExists: true,
		}),
		planPaths: context.planPaths,
		memoryPaths: null,
		gitReality: null,
		memoryGate: null,
		memoryCheckpoint: null,
		instructions: null,
		worktreeExists: true,
	};
	return { ...setup, preflight };
}

function buildState(input: Partial<PlanStateRecord>): PlanStateRecord {
	return {
		...createInitialPlanState({
			baseBranch: "main",
			planBranch: "plan/plan-a",
			worktreePath: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
		}),
		currentBranch: "plan/plan-a",
		lastCheckpointCommit: "abc123",
		...input,
	};
}
