import { describe, expect, it } from "vitest";
import { createPlanStoragePaths } from "../storage/paths";
import {
	createInitialPlanState,
	type PlanStateRecord,
} from "../storage/schema";
import { MockPlannerFs } from "../test/mock-fs";
import {
	applyToolEvent,
	buildRecoveryReport,
	createDiagnosticsRecord,
	createPseudonymizer,
	evaluatePlannerStuck,
	MAX_TOOL_TIMELINE,
	type PlannerToolEvent,
	RECOVERY_ISSUE_URL,
	readDiagnosticsRecord,
	recordPlannerToolEvent,
	sanitizePlanState,
} from "./diagnostics";

function event(overrides: Partial<PlannerToolEvent> = {}): PlannerToolEvent {
	return {
		ts: 1_000,
		tool: "planner_finish_step",
		status: "blocked",
		stage: "execution",
		step: "merge_task_to_plan",
		task: "create-parser-agents",
		...overrides,
	};
}

function stuckState(): PlanStateRecord {
	const state = createInitialPlanState({
		baseBranch: "main",
		planBranch: "plan/secret-project-9af3",
		worktreePath: "/home/alice/work/secret-project/.pi/worktrees/secret-9af3",
	});
	return {
		...state,
		stage: "execution",
		step: "merge_task_to_plan",
		stepStatus: "running",
		activeTaskId: "create-parser-agents",
		currentBranch: "plan/secret-project-9af3",
		activeBranches: {
			base: "main",
			plan: "plan/secret-project-9af3",
			currentTask: "task/secret-project-9af3/create-parser-agents",
		},
		managedBranches: {
			tasks: {
				"create-parser-agents": {
					task: "task/secret-project-9af3/create-parser-agents",
					refactor: null,
				},
			},
		},
		mergeTargets: {
			taskToPlan: "plan/secret-project-9af3",
			planToOutput: null,
		},
	};
}

describe("applyToolEvent counter logic", () => {
	it("grows the blocked streak and stamps firstBlockedAt once", () => {
		let record = createDiagnosticsRecord();
		record = applyToolEvent(record, event({ ts: 100, status: "blocked" }));
		record = applyToolEvent(record, event({ ts: 200, status: "blocked" }));
		expect(record.consecutiveBlocked).toBe(2);
		expect(record.firstBlockedAt).toBe(100);
		expect(record.lastBlockedStep).toBe("merge_task_to_plan");
	});

	it("resets the streak on an applied (progress) result", () => {
		let record = createDiagnosticsRecord();
		record = applyToolEvent(record, event({ status: "blocked" }));
		record = applyToolEvent(record, event({ status: "blocked" }));
		record = applyToolEvent(
			record,
			event({ tool: "planner_finish_step", status: "applied" }),
		);
		expect(record.consecutiveBlocked).toBe(0);
		expect(record.firstBlockedAt).toBeNull();
		expect(record.lastBlockedStep).toBeNull();
	});

	it("never accumulates on legitimately repeated applied commands", () => {
		let record = createDiagnosticsRecord();
		for (let i = 0; i < 10; i += 1) {
			record = applyToolEvent(
				record,
				event({ tool: "planner_contract_read", status: "applied" }),
			);
		}
		expect(record.consecutiveBlocked).toBe(0);
	});

	it("counts recovery wrapper calls", () => {
		let record = createDiagnosticsRecord();
		record = applyToolEvent(
			record,
			event({ tool: "planner_recovery_inspect", status: "applied" }),
		);
		record = applyToolEvent(
			record,
			event({ tool: "planner_recovery_resume", status: "applied" }),
		);
		expect(record.recoveryCalls).toBe(2);
	});

	it("caps the timeline length", () => {
		let record = createDiagnosticsRecord();
		for (let i = 0; i < MAX_TOOL_TIMELINE + 50; i += 1) {
			record = applyToolEvent(record, event({ ts: i, status: "applied" }));
		}
		expect(record.toolTimeline.length).toBe(MAX_TOOL_TIMELINE);
		// The oldest events were dropped; the most recent survive.
		expect(record.toolTimeline.at(-1)?.ts).toBe(MAX_TOOL_TIMELINE + 49);
	});
});

describe("evaluatePlannerStuck", () => {
	const thresholds = { blockedTransitions: 4, stuckMs: 25 * 60_000 };

	it("is not stuck on a short blocked streak", () => {
		let record = createDiagnosticsRecord();
		record = applyToolEvent(record, event({ ts: 0, status: "blocked" }));
		record = applyToolEvent(record, event({ ts: 1, status: "blocked" }));
		expect(evaluatePlannerStuck(record, 2, thresholds).stuck).toBe(false);
	});

	it("does not false-fire while progress keeps resetting the streak", () => {
		let record = createDiagnosticsRecord();
		// Alternating blocked/applied: 150 calls, but progress resets each time.
		for (let i = 0; i < 150; i += 1) {
			record = applyToolEvent(
				record,
				event({ ts: i, status: i % 2 === 0 ? "blocked" : "applied" }),
			);
		}
		expect(evaluatePlannerStuck(record, 150, thresholds).stuck).toBe(false);
	});

	it("fires on the blocked-transition threshold", () => {
		let record = createDiagnosticsRecord();
		for (let i = 0; i < 4; i += 1) {
			record = applyToolEvent(record, event({ ts: i, status: "blocked" }));
		}
		const result = evaluatePlannerStuck(record, 4, thresholds);
		expect(result.stuck).toBe(true);
		expect(result.reasons.join(" ")).toContain("blocked planner transitions");
	});

	it("fires on the time threshold even with a single block", () => {
		let record = createDiagnosticsRecord();
		record = applyToolEvent(record, event({ ts: 0, status: "blocked" }));
		const now = 26 * 60_000;
		const result = evaluatePlannerStuck(record, now, thresholds);
		expect(result.stuck).toBe(true);
		expect(result.reasons.join(" ")).toContain("stuck for");
	});

	it("fires once a recovery wrapper was called", () => {
		let record = createDiagnosticsRecord();
		record = applyToolEvent(
			record,
			event({ tool: "planner_recovery_inspect", status: "applied" }),
		);
		expect(evaluatePlannerStuck(record, 1, thresholds).stuck).toBe(true);
	});
});

describe("pseudonymizer", () => {
	it("assigns stable tokens in first-seen order and passes null through", () => {
		const pseudo = createPseudonymizer();
		expect(pseudo.token(null)).toBeNull();
		expect(pseudo.token("create-parser-agents")).toBe("T1");
		expect(pseudo.token("create-docs-agents")).toBe("T2");
		expect(pseudo.token("create-parser-agents")).toBe("T1");
		expect(pseudo.legend()).toEqual([
			{ token: "T1", realId: "create-parser-agents" },
			{ token: "T2", realId: "create-docs-agents" },
		]);
	});
});

describe("sanitizePlanState", () => {
	it("keeps structure but pseudonymizes ids and drops paths", () => {
		const pseudo = createPseudonymizer();
		const sanitized = sanitizePlanState(stuckState(), pseudo);
		expect(sanitized.activeTask).toBe("T1");
		expect(sanitized.managedTasks).toEqual(["T1"]);
		expect(sanitized.branches).toEqual({
			base: true,
			plan: true,
			currentTask: true,
		});
		expect(sanitized.mergeTargets).toEqual({
			taskToPlan: true,
			planToOutput: false,
		});
		// No raw id or path leaked into any string field.
		const serialized = JSON.stringify(sanitized);
		expect(serialized).not.toContain("create-parser-agents");
		expect(serialized).not.toContain("secret-project");
		expect(serialized).not.toContain("/home/alice");
	});
});

describe("buildRecoveryReport confidentiality", () => {
	const diagnostics = (() => {
		let record = createDiagnosticsRecord();
		record = applyToolEvent(
			record,
			event({
				ts: 0,
				tool: "planner_git_merge_task_to_plan",
				status: "applied",
			}),
		);
		for (let i = 1; i <= 4; i += 1) {
			record = applyToolEvent(record, event({ ts: i, status: "blocked" }));
		}
		return record;
	})();

	const built = buildRecoveryReport({
		state: stuckState(),
		plan: {
			schemaVersion: 1,
			planId: "secret-project-9af3",
			title: "Secret VRF compiler internals",
			description: "Confidential client project",
			status: "active",
			tasks: [
				{
					taskId: "create-parser-agents",
					title: "Parser AGENTS.md",
					status: "done",
				},
				{
					taskId: "create-solver-agents",
					title: "Solver AGENTS.md",
					status: "pending",
				},
			],
		},
		diagnostics,
		evaluation: evaluatePlannerStuck(diagnostics, 5, {
			blockedTransitions: 4,
			stuckMs: 25 * 60_000,
		}),
		modelId: "llama-cpp/qwen3.6-35b",
		now: 5,
		issueUrl: RECOVERY_ISSUE_URL,
	});

	it("never leaks raw ids, paths, titles, or descriptions", () => {
		const leaks = [
			"create-parser-agents",
			"create-solver-agents",
			"secret-project",
			"/home/alice",
			"Secret VRF compiler internals",
			"Confidential client project",
			"task/secret-project",
		];
		for (const needle of leaks) {
			expect(built.report).not.toContain(needle);
		}
	});

	it("includes pseudonymized tokens, the model, and the issue link", () => {
		expect(built.report).toContain("T1");
		expect(built.report).toContain("llama-cpp/qwen3.6-35b");
		expect(built.report).toContain(RECOVERY_ISSUE_URL);
		expect(built.report).toContain("planner_git_merge_task_to_plan");
		expect(built.report).toContain("blocked");
	});

	it("keeps the real ids only in the local legend, not the report", () => {
		expect(built.legend).toContain("create-parser-agents");
		expect(built.legend).toContain("T1");
		expect(built.report).not.toContain("create-parser-agents");
	});
});

describe("diagnostics sidecar persistence", () => {
	it("round-trips through the filesystem", async () => {
		const fs = new MockPlannerFs();
		const planPaths = createPlanStoragePaths(
			{
				agentDir: "/agent",
				extensionDir: "/agent/extensions/pi-code-planner",
				projectRoot: "/repo",
				projectId: "p",
				displayName: "repo",
				projectDir: "/agent/extensions/pi-code-planner/projects/p",
				projectJson: "/x/project.json",
				plansDir: "/agent/extensions/pi-code-planner/plans",
				instructionsDir: "/i",
				projectLocalDir: "/repo/.pi/pi-code-planner",
			},
			"plan-1",
		);
		await recordPlannerToolEvent(fs, planPaths, event({ status: "blocked" }));
		const reread = await readDiagnosticsRecord(fs, planPaths);
		expect(reread.consecutiveBlocked).toBe(1);
		expect(reread.toolTimeline).toHaveLength(1);
		expect(reread.toolTimeline[0]?.tool).toBe("planner_finish_step");
	});

	it("returns a fresh record when the sidecar is absent", async () => {
		const fs = new MockPlannerFs();
		const planPaths = createPlanStoragePaths(
			{
				agentDir: "/agent",
				extensionDir: "/agent/extensions/pi-code-planner",
				projectRoot: "/repo",
				projectId: "p",
				displayName: "repo",
				projectDir: "/d",
				projectJson: "/x/project.json",
				plansDir: "/agent/extensions/pi-code-planner/plans",
				instructionsDir: "/i",
				projectLocalDir: "/repo/.pi/pi-code-planner",
			},
			"plan-2",
		);
		const record = await readDiagnosticsRecord(fs, planPaths);
		expect(record.consecutiveBlocked).toBe(0);
		expect(record.toolTimeline).toEqual([]);
	});
});
