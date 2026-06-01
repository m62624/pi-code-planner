import { describe, expect, it } from "vitest";
import { EXTENSION_NAME, SCHEMA_VERSION } from "../constants";
import { MockPlannerFs } from "../test/mock-fs";
import { createProjectId } from "./ids";
import { type PlannerJsonError, readJson, writeJson } from "./json";
import { createPlanStoragePaths, createProjectStoragePaths } from "./paths";
import {
	initializePlanFiles,
	readPlanRecord,
	updatePlanRecord,
} from "./plan-store";
import {
	ensureProjectRecord,
	setActivePlan,
	upsertProjectPlanSummary,
} from "./project-store";
import {
	createInitialPlanState,
	createPlanRecord,
	PLANNER_STAGE_STEPS,
	type PlanStateRecord,
} from "./schema";
import {
	completePlanStep,
	initializePlanState,
	markPlanBroken,
	readPlanState,
	setPlanStep,
	updatePlanState,
} from "./state-store";

describe("storage ids and paths", () => {
	it("creates stable project ids from project root", () => {
		expect(createProjectId("/home/me/Projects/My App")).toMatch(
			/^my-app-[a-f0-9]{8}$/,
		);
		expect(createProjectId("/home/me/Projects/My App")).toBe(
			createProjectId("/home/me/Projects/My App"),
		);
		expect(createProjectId("/tmp/Projects/My App")).not.toBe(
			createProjectId("/home/me/Projects/My App"),
		);
	});

	it("creates extension, project, and plan paths under agent dir", () => {
		const project = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/pi-approval-modes",
		});
		const plan = createPlanStoragePaths(project, "plan-a");

		expect(project.extensionDir).toBe(`/agent/extensions/${EXTENSION_NAME}`);
		expect(project.projectJson).toContain(
			"/agent/extensions/pi-code-planner/projects/",
		);
		expect(project.projectJson).toContain("/project.json");
		expect(project.instructionsDir).toBe(
			"/agent/extensions/pi-code-planner/instructions",
		);
		expect(plan.stateJson).toContain("/plans/plan-a/state.json");
		expect(plan.tasksDir).toContain("/plans/plan-a/tasks");
	});
});

describe("json store", () => {
	it("writes formatted json atomically and reads it back", async () => {
		const fs = new MockPlannerFs();
		await writeJson(fs, "/tmp/state.json", { ok: true });

		await expect(
			readJson<{ ok: boolean }>(fs, "/tmp/state.json"),
		).resolves.toEqual({ ok: true });
		expect(fs.atomicWrites).toEqual(["/tmp/state.json"]);
		expect(fs.snapshot()["/tmp/state.json"]).toBe('{\n  "ok": true\n}\n');
	});

	it("wraps invalid json errors with the failing path", async () => {
		const fs = new MockPlannerFs();
		await fs.writeText("/tmp/bad.json", "{");

		await expect(readJson(fs, "/tmp/bad.json")).rejects.toMatchObject({
			name: "PlannerJsonError",
			path: "/tmp/bad.json",
		} satisfies Partial<PlannerJsonError>);
	});
});

describe("project record store", () => {
	it("creates project.json once and keeps it separate from plan state", async () => {
		const fs = new MockPlannerFs();
		const paths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});

		const created = await ensureProjectRecord(fs, paths);
		const loaded = await ensureProjectRecord(fs, paths);

		expect(created).toEqual({
			schemaVersion: SCHEMA_VERSION,
			projectId: paths.projectId,
			projectRoot: "/repo/app",
			displayName: "app",
			activePlanId: null,
			plans: [],
		});
		expect(loaded).toEqual(created);
		expect(fs.snapshot()[paths.projectJson]).toBeDefined();
	});

	it("upserts plan summaries and switches active plan without touching per-plan state", async () => {
		const fs = new MockPlannerFs();
		const project = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});

		await upsertProjectPlanSummary(fs, project, {
			planId: "plan-a",
			title: "Plan A",
			status: "active",
		});
		await upsertProjectPlanSummary(fs, project, {
			planId: "plan-a",
			title: "Plan A renamed",
			status: "paused",
		});
		const record = await setActivePlan(fs, project, "plan-a");

		expect(record.activePlanId).toBe("plan-a");
		expect(record.plans).toEqual([
			{ planId: "plan-a", title: "Plan A renamed", status: "paused" },
		]);
	});
});

describe("plan record store", () => {
	it("initializes plan json and empty markdown artifacts", async () => {
		const fs = new MockPlannerFs();
		const project = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		const planPaths = createPlanStoragePaths(project, "plan-a");
		const plan = createPlanRecord({ planId: "plan-a", title: "Build planner" });

		await initializePlanFiles(fs, planPaths, plan);

		await expect(readPlanRecord(fs, planPaths)).resolves.toEqual(plan);
		expect(fs.snapshot()[planPaths.planMd]).toBe("");
		expect(fs.snapshot()[planPaths.discoveryMd]).toBe("");
		expect(fs.snapshot()[planPaths.questionsMd]).toBe("");
		expect(fs.snapshot()[planPaths.decisionsMd]).toBe("");
		expect(await fs.exists(planPaths.memoryDir)).toBe(true);
		expect(await fs.exists(planPaths.tasksDir)).toBe(true);
	});

	it("updates task list in plan.json without runtime fields", async () => {
		const fs = new MockPlannerFs();
		const project = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		const planPaths = createPlanStoragePaths(project, "plan-a");
		await initializePlanFiles(
			fs,
			planPaths,
			createPlanRecord({ planId: "plan-a", title: "Build planner" }),
		);

		const updated = await updatePlanRecord(fs, planPaths, (plan) => ({
			...plan,
			tasks: [{ taskId: "task-1", title: "First task", status: "pending" }],
		}));

		expect(updated.tasks).toHaveLength(1);
		expect("stage" in updated).toBe(false);
		expect("currentBranch" in updated).toBe(false);
	});
});

describe("plan state store", () => {
	it("declares every documented stage step as runtime data", () => {
		expect(PLANNER_STAGE_STEPS).toEqual({
			init: [
				"check_project",
				"check_git",
				"prepare_storage",
				"choose_worktree_location",
				"create_plan_record",
				"create_plan_worktree",
				"enter_intake",
			],
			intake: ["draft_goal", "await_goal_approval"],
			discovery: [
				"scan_project_structure",
				"index_files_iteratively",
				"write_project_patterns",
				"write_relations",
				"write_questions",
				"verify_memory",
				"compact_discovery",
				"enter_planning",
			],
			planning: [
				"read_memory",
				"draft_plan",
				"split_tasks",
				"write_task_files",
				"verify_plan",
				"compact_planning",
				"enter_execution",
			],
			execution: [
				"prepare_task",
				"write_tdd_plan",
				"write_tests",
				"run_failing_tests",
				"start_experiments",
				"run_experiment",
				"summarize_experiment",
				"compact_experiment",
				"select_experiment",
				"merge_best_experiment",
				"refactor_task",
				"run_final_tests",
				"merge_task_to_plan",
				"compact_task",
				"select_next_task",
			],
			finalize: [
				"verify_plan_branch",
				"write_final_summary",
				"compact_finalize",
				"enter_done",
			],
			done: [
				"present_result",
				"await_user_acceptance",
				"handle_change_request",
				"prepare_output_branch",
				"merge_or_export_result",
				"cleanup_worktree",
				"mark_done",
				"cleanup_plan_files",
			],
			recovery: [
				"read_state",
				"inspect_git",
				"compare_expected_actual",
				"classify_recovery",
				"ask_user_if_destructive",
				"repair_or_resume",
			],
		});
	});

	it("keeps documented stage step counts stable", () => {
		expect(
			Object.fromEntries(
				Object.entries(PLANNER_STAGE_STEPS).map(([stage, steps]) => [
					stage,
					steps.length,
				]),
			),
		).toEqual({
			init: 7,
			intake: 2,
			discovery: 8,
			planning: 7,
			execution: 15,
			finalize: 4,
			done: 8,
			recovery: 6,
		});
	});

	it("stores runtime state per plan and keeps plans isolated", async () => {
		const fs = new MockPlannerFs();
		const project = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		const planA = createPlanStoragePaths(project, "plan-a");
		const planB = createPlanStoragePaths(project, "plan-b");

		await initializePlanState(
			fs,
			planA,
			createInitialPlanState({ baseBranch: "main", planBranch: "plan/plan-a" }),
		);
		await initializePlanState(
			fs,
			planB,
			createInitialPlanState({ baseBranch: "main", planBranch: "plan/plan-b" }),
		);
		await setPlanStep(fs, planA, {
			stage: "discovery",
			step: "scan_project_structure",
			nextStep: "write_project_patterns",
		});

		expect((await readPlanState(fs, planA)).stage).toBe("discovery");
		expect((await readPlanState(fs, planB)).stage).toBe("init");
	});

	it("records completed step and nextStep so restart can continue without repeating", async () => {
		const fs = new MockPlannerFs();
		const project = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		const planPaths = createPlanStoragePaths(project, "plan-a");
		await initializePlanState(
			fs,
			planPaths,
			createInitialPlanState({ baseBranch: "main", planBranch: "plan/plan-a" }),
		);
		await setPlanStep(fs, planPaths, {
			stage: "discovery",
			step: "scan_project_structure",
			stepStatus: "running",
		});

		const completed = await completePlanStep(
			fs,
			planPaths,
			"write_project_patterns",
		);

		expect(completed).toMatchObject({
			stage: "discovery",
			step: "scan_project_structure",
			stepStatus: "completed",
			nextStep: "write_project_patterns",
		} satisfies Partial<PlanStateRecord>);
	});

	it("marks broken state as recovery and requiring user decision", async () => {
		const fs = new MockPlannerFs();
		const project = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		const planPaths = createPlanStoragePaths(project, "plan-a");
		await initializePlanState(
			fs,
			planPaths,
			createInitialPlanState({ baseBranch: "main", planBranch: "plan/plan-a" }),
		);

		const broken = await markPlanBroken(
			fs,
			planPaths,
			"expected worktree is missing",
		);

		expect(broken).toMatchObject({
			stage: "recovery",
			step: "read_state",
			stepStatus: "blocked",
			broken: true,
			brokenReason: "expected worktree is missing",
			requiresUserDecision: true,
		} satisfies Partial<PlanStateRecord>);
	});

	it("allows targeted state updates for branch and checkpoint fields", async () => {
		const fs = new MockPlannerFs();
		const project = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		const planPaths = createPlanStoragePaths(project, "plan-a");
		await initializePlanState(
			fs,
			planPaths,
			createInitialPlanState({ baseBranch: "main", planBranch: "plan/plan-a" }),
		);

		const updated = await updatePlanState(fs, planPaths, (state) => ({
			...state,
			worktreePath: "/repo/app/.pi/worktrees/plan-a",
			currentBranch: "plan/plan-a",
			lastCheckpointCommit: "abc123",
		}));

		expect(updated.worktreePath).toBe("/repo/app/.pi/worktrees/plan-a");
		expect(updated.currentBranch).toBe("plan/plan-a");
		expect(updated.lastCheckpointCommit).toBe("abc123");
	});
});
