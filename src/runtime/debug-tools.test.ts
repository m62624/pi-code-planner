import { describe, expect, it } from "vitest";
import type {
	GitBranchInput,
	GitCommitInput,
	GitCreateBranchInput,
	GitDeleteBranchInput,
	GitMergeInput,
	GitRepoInput,
	GitRunner,
	GitSwitchBranchInput,
	GitWorktreeAddInput,
	GitWorktreeRemoveInput,
} from "../git/runner";
import {
	createPlanStoragePaths,
	createProjectStoragePaths,
} from "../storage/paths";
import { initializePlanFiles } from "../storage/plan-store";
import { ensureProjectRecord, setActivePlan } from "../storage/project-store";
import { createInitialPlanState, createPlanRecord } from "../storage/schema";
import { initializePlanState, readPlanState } from "../storage/state-store";
import { MockPlannerFs } from "../test/mock-fs";
import { executePlannerDebugTool } from "./debug-tools";

class MockGitRunner implements GitRunner {
	async init(_input: GitRepoInput): Promise<void> {}
	async currentBranch(_input: GitRepoInput): Promise<string> {
		return "task/plan-a/task-1";
	}
	async headCommit(_input: GitRepoInput): Promise<string> {
		return "abc123";
	}
	async statusPorcelain(_input: GitRepoInput): Promise<string> {
		return "";
	}
	async diffStat(_input: GitRepoInput): Promise<string> {
		return "";
	}
	async diffNameOnly(_input: GitRepoInput): Promise<string> {
		return "";
	}
	async listProjectFiles(_input: GitRepoInput): Promise<string[]> {
		return [];
	}
	async branchExists(_input: GitBranchInput): Promise<boolean> {
		return true;
	}
	async createBranch(_input: GitCreateBranchInput): Promise<void> {}
	async deleteBranch(_input: GitDeleteBranchInput): Promise<void> {}
	async switchBranch(_input: GitSwitchBranchInput): Promise<void> {}
	async stageAll(_input: GitRepoInput): Promise<void> {}
	async commit(_input: GitCommitInput): Promise<void> {}
	async merge(_input: GitMergeInput): Promise<void> {}
	async worktreeAdd(_input: GitWorktreeAddInput): Promise<void> {}
	async worktreeRemove(_input: GitWorktreeRemoveInput): Promise<void> {}
}

describe("planner debug tools", () => {
	it("blocks debug tools before a stuck attempt exists", async () => {
		const setup = await createDebugSetup({ stuck: false });

		const result = await executePlannerDebugTool({
			...setup,
			toolName: "planner_debug_strategy",
			params: strategyParams(),
		});

		expect(result.status).toBe("blocked");
		expect(result.text).toContain("blocked");
	});

	it("records strategy, probe, and result in the worktree debug directory", async () => {
		const setup = await createDebugSetup();

		const strategy = await executePlannerDebugTool({
			...setup,
			toolName: "planner_debug_strategy",
			params: strategyParams(),
		});
		const probe = await executePlannerDebugTool({
			...setup,
			toolName: "planner_debug_probe",
			params: {
				question: "Which codec branch loses the sign?",
				hypothesis: "The signed decode branch drops the sign flag.",
				method: "add_temp_log",
				instrumentation: "temp_file",
				target: "focused codec test",
				expectedSignal: "temp output shows sign flag before decode",
				cleanupRequired: true,
			},
		});
		const probeId = (probe.details as { probeId: string }).probeId;
		const result = await executePlannerDebugTool({
			...setup,
			toolName: "planner_debug_result",
			params: {
				observedSignal:
					"sign flag is present before decode and lost after mask",
				signalMatched: true,
				conclusion: "Patch the mask operation, not the test.",
				cleanupDone: false,
				nextAction: "patch",
			},
		});

		expect(strategy.status).toBe("applied");
		expect(probe.status).toBe("applied");
		expect(result.status).toBe("applied");
		expect(probeId).toMatch(/^probe-[a-f0-9]{8}$/);
		const snapshot = setup.fs.snapshot();
		expect(
			Object.keys(snapshot).some((path) => path.endsWith("strategy.md")),
		).toBe(true);
		expect(
			Object.keys(snapshot).some((path) => path.endsWith("probe.md")),
		).toBe(true);
		expect(
			Object.keys(snapshot).some((path) => path.endsWith("temp-output.log")),
		).toBe(true);
		await expect(
			readPlanState(setup.fs, setup.planPaths),
		).resolves.toMatchObject({
			activeDebugProbeId: null,
			debugCleanupRequired: true,
		});
	});

	it("blocks probe if strategy has not been written", async () => {
		const setup = await createDebugSetup();

		const result = await executePlannerDebugTool({
			...setup,
			toolName: "planner_debug_probe",
			params: {
				question: "Which branch loses the sign?",
				hypothesis: "The mask drops the sign flag.",
				method: "add_temp_log",
				instrumentation: "temp_file",
				target: "focused codec test",
				expectedSignal: "temp output shows sign flag before decode",
				cleanupRequired: true,
			},
		});

		expect(result.status).toBe("blocked");
		expect(result.text).toContain("planner_debug_strategy");
	});

	it("blocks probe if a previous probe has no result yet", async () => {
		const setup = await createDebugSetup();

		await executePlannerDebugTool({
			...setup,
			toolName: "planner_debug_strategy",
			params: strategyParams(),
		});
		await executePlannerDebugTool({
			...setup,
			toolName: "planner_debug_probe",
			params: {
				question: "Which branch loses the sign?",
				hypothesis: "The mask drops the sign flag.",
				method: "add_temp_log",
				instrumentation: "temp_file",
				target: "focused codec test",
				expectedSignal: "temp output shows sign flag",
				cleanupRequired: true,
			},
		});
		const second = await executePlannerDebugTool({
			...setup,
			toolName: "planner_debug_probe",
			params: {
				question: "Does the issue occur before masking?",
				hypothesis: "The problem is earlier in the pipeline.",
				method: "inspect_file",
				instrumentation: "none",
				target: "codec.ts",
				expectedSignal: "no sign flag in input",
				cleanupRequired: false,
			},
		});

		expect(second.status).toBe("blocked");
		expect(second.text).toContain("planner_debug_result");
	});

	it("cleanup removes debug artifacts and clears commit guard state", async () => {
		const setup = await createDebugSetup();

		const cleanup = await executePlannerDebugTool({
			...setup,
			toolName: "planner_debug_cleanup",
			params: {},
		});

		expect(cleanup.status).toBe("applied");
		expect(await readPlanState(setup.fs, setup.planPaths)).toMatchObject({
			debugSessionId: null,
			debugArtifactsDir: null,
			debugCleanupRequired: false,
		});
		expect(await setup.fs.exists(setup.debugArtifactsDir)).toBe(false);
	});
});

function strategyParams() {
	return {
		runtimeTarget: "native Rust test runner",
		availableSignals: ["cargo test output", "stdout with --nocapture"],
		safeInstrumentation: ["temporary println in focused test"],
		forbiddenInstrumentation: ["committed persistent debug logs"],
		cleanupPlan:
			"remove temporary println and planner debug artifacts before commit",
	};
}

async function createDebugSetup(input: { stuck?: boolean } = {}) {
	const fs = new MockPlannerFs();
	const git = new MockGitRunner();
	const projectPaths = createProjectStoragePaths({
		agentDir: "/agent",
		projectRoot: "/repo/app",
	});
	const planPaths = createPlanStoragePaths(projectPaths, "plan-a");
	const worktreePath = "/repo/app/.pi/pi-code-planner/worktrees/plan-a";
	const debugArtifactsDir = `${worktreePath}/.pi/pi-code-planner/debug/task-1/attempt-001-deadbeef`;
	await ensureProjectRecord(fs, projectPaths);
	await initializePlanFiles(
		fs,
		planPaths,
		createPlanRecord({ planId: "plan-a", title: "Plan A" }),
	);
	await fs.mkdirp(worktreePath);
	await fs.mkdirp(debugArtifactsDir);
	await fs.writeTextAtomic(`${debugArtifactsDir}/README.md`, "debug\n");
	await initializePlanState(fs, planPaths, {
		...createInitialPlanState({
			baseBranch: "main",
			planBranch: "plan/plan-a",
			worktreePath,
		}),
		stage: "execution",
		step: "implement_task",
		stepStatus: "running",
		activeTaskId: "task-1",
		currentBranch: "task/plan-a/task-1",
		activeBranches: {
			base: "main",
			plan: "plan/plan-a",
			currentTask: "task/plan-a/task-1",
		},
		lastStuckAttemptId: input.stuck === false ? null : "attempt-001",
		lastStuckReportPath:
			input.stuck === false ? null : `${planPaths.tasksDir}/task-1/stuck.md`,
		debugSessionId: input.stuck === false ? null : "attempt-001-deadbeef",
		debugArtifactsDir: input.stuck === false ? null : debugArtifactsDir,
		debugCleanupRequired: input.stuck !== false,
	});
	await setActivePlan(fs, projectPaths, "plan-a");
	return { fs, git, projectPaths, planPaths, debugArtifactsDir };
}
