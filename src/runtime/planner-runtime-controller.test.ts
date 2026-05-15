import { describe, expect, it, vi } from "vitest";
import { PlannerArtifacts } from "../artifacts/planner-artifacts";
import { CompactionCoordinator } from "../compaction/coordinator";
import type { RepoState } from "../git/state";
import { emptyGitStatusSummary } from "../git/status-parser";
import {
	PlannerOrchestrator,
	type PlannerOrchestratorOptions,
} from "../orchestrator/planner-orchestrator";
import { RuntimeStateManager } from "../planner-state/runtime";
import { DEFAULT_SETTINGS } from "../settings/defaults";
import { createSettingsPaths } from "../settings/paths";
import type { SettingsLoadResult } from "../settings/schema";
import { PlanStore } from "../storage/store";
import { MemoryFs } from "../test/memory-fs";
import { WorkflowManager } from "../workflow/manager";
import { PlannerRuntimeController } from "./planner-runtime-controller";

const paths = createSettingsPaths({
	agentDir: "/agent",
	cwd: "/repo",
	extensionName: "pi-planner",
});

function repoState(input: Partial<RepoState> = {}): RepoState {
	return {
		cwd: "/repo",
		repoRoot: "/repo",
		isRepo: true,
		currentBranch: null,
		currentCommit: "commit-1",
		isDetachedHead: false,
		status: emptyGitStatusSummary(),
		...input,
	};
}

function settingsLoadResult(): SettingsLoadResult {
	return {
		settings: DEFAULT_SETTINGS,
		sources: {
			defaults: "built-in",
			instructions: {
				plan: "/agent/extensions/pi-planner/instructions/plan.md",
				discovery: "/agent/extensions/pi-planner/instructions/discovery.md",
				work_item: "/agent/extensions/pi-planner/instructions/work_item.md",
				compact: "/agent/extensions/pi-planner/instructions/compact.md",
			},
		},
	};
}

function createHarness(repo: RepoState = repoState()) {
	const fs = new MemoryFs();
	fs.setFile(
		"/agent/extensions/pi-planner/instructions/plan.md",
		"Plan instruction",
	);
	fs.setFile(
		"/agent/extensions/pi-planner/instructions/discovery.md",
		"Discovery instruction",
	);
	fs.setFile(
		"/agent/extensions/pi-planner/instructions/work_item.md",
		"Work item instruction",
	);
	fs.setFile(
		"/agent/extensions/pi-planner/instructions/compact.md",
		"Compact instruction",
	);
	const runtime = new RuntimeStateManager({ paths, fs });
	runtime.initialize();
	const store = new PlanStore({ paths, fs });
	const options: PlannerOrchestratorOptions = {
		projectPath: "/repo",
		store,
		workflow: new WorkflowManager(store),
		runtime,
		compactor: new CompactionCoordinator({
			state: runtime,
			createId: () => "compact-1",
			now: () => "2026-05-15T00:00:00.000Z",
		}),
		fs,
		settings: settingsLoadResult(),
		artifacts: new PlannerArtifacts({ paths, fs }),
	};
	const orchestrator = new PlannerOrchestrator(options);
	const readRepoState = vi.fn().mockResolvedValue(repo);
	const controller = new PlannerRuntimeController(
		{ state: runtime, readRepoState },
		orchestrator,
	);

	return { controller, fs, orchestrator, readRepoState, runtime };
}

describe("PlannerRuntimeController", () => {
	it("reports idle when no planner is active", async () => {
		const { controller } = createHarness();

		const inspection = await controller.inspect();

		expect(inspection).toMatchObject({
			status: "idle",
			message: "Planner is idle.",
			plan: null,
			workItem: null,
			nextPrompt: null,
			recovery: { status: "inactive" },
		});
	});

	it("returns the active plan prompt when runtime is healthy", async () => {
		const { controller, orchestrator } = createHarness();
		orchestrator.createPlan({ title: "Plan", planId: "plan-1" });
		orchestrator.transitionPlan("plan-1", "discovery_full");

		const inspection = await controller.inspect();

		expect(inspection.status).toBe("ready");
		expect(inspection.plan).toMatchObject({
			planId: "plan-1",
			stage: "discovery_full",
		});
		expect(inspection.nextPrompt?.prompt).toContain("Discovery instruction");
		expect(inspection.nextPrompt?.prompt).toContain("- planId: plan-1");
	});

	it("returns the active work item prompt when a work item is active", async () => {
		const { controller, orchestrator } = createHarness();
		orchestrator.createPlan({ title: "Plan", planId: "plan-1" });
		orchestrator.createWorkItem("plan-1", {
			title: "Parser API",
			workItemId: "parser-api",
		});
		orchestrator.transitionWorkItem("plan-1", "parser-api", "ready");
		orchestrator.transitionWorkItem("plan-1", "parser-api", "active");

		const inspection = await controller.inspect();

		expect(inspection.status).toBe("ready");
		expect(inspection.workItem).toMatchObject({
			workItemId: "parser-api",
			stage: "active",
		});
		expect(inspection.nextPrompt?.prompt).toContain("Work item instruction");
		expect(inspection.nextPrompt?.prompt).toContain("- workItemId: parser-api");
	});

	it("blocks normal work while compaction is pending", async () => {
		const { controller, orchestrator, runtime } = createHarness();
		orchestrator.createPlan({ title: "Plan", planId: "plan-1" });
		runtime.update((state) => ({
			...state,
			pendingCompact: {
				id: "compact-1",
				reason: "discovery",
				status: "requested",
				requestedAt: "2026-05-15T00:00:00.000Z",
				completedAt: null,
				failedAt: null,
				error: null,
				activePlanId: "plan-1",
				activeWorkItemId: null,
				customInstructions: "compact",
				resumePrompt: "resume",
				attachToNextTurn: true,
				autoResume: true,
			},
		}));

		const inspection = await controller.inspect();

		expect(inspection).toMatchObject({
			status: "compact_pending",
			message: "Planner compact is pending: compact-1.",
			nextPrompt: null,
		});
	});

	it("reports recovery when git state diverges", async () => {
		const dirty = emptyGitStatusSummary();
		dirty.unstagedFiles.push("src/app.ts");
		const { controller, orchestrator } = createHarness(
			repoState({
				status: { ...dirty, hasUnstagedChanges: true, isDirty: true },
			}),
		);
		orchestrator.createPlan({ title: "Plan", planId: "plan-1" });

		const inspection = await controller.inspect();

		expect(inspection).toMatchObject({
			status: "recovery_required",
			nextPrompt: null,
			recovery: {
				status: "dirty_worktree",
			},
		});
	});
});
