import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
import { createNodeFs } from "../storage/fs";
import {
	createPlanStoragePaths,
	createProjectStoragePaths,
} from "../storage/paths";
import { initializePlanFiles } from "../storage/plan-store";
import { ensureProjectRecord, setActivePlan } from "../storage/project-store";
import {
	createInitialPlanState,
	createPlanRecord,
	type PlannerStep,
} from "../storage/schema";
import { initializePlanState } from "../storage/state-store";
import { executePlannerElenchusTool } from "./elenchus-tools";

// The elenchus tool never touches git, but the orchestrator preflight inspects
// the current branch — so the mock reports the active plan branch as clean.
class MockGitRunner implements GitRunner {
	async init(_input: GitRepoInput): Promise<void> {}
	async currentBranch(_input: GitRepoInput): Promise<string> {
		return "plan/plan-a";
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

const git = new MockGitRunner();

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

async function createSetup(step: PlannerStep = "consistency_check") {
	const root = await mkdtemp(join(tmpdir(), "elenchus-tools-"));
	tempDirs.push(root);
	const fs = createNodeFs();
	const agentDir = join(root, "agent");
	const projectRoot = join(root, "repo");
	const projectPaths = createProjectStoragePaths({ agentDir, projectRoot });
	const planPaths = createPlanStoragePaths(projectPaths, "plan-a");
	const worktreePath = join(
		projectRoot,
		".pi",
		"pi-code-planner",
		"worktrees",
		"plan-a",
	);
	await ensureProjectRecord(fs, projectPaths);
	await initializePlanFiles(
		fs,
		planPaths,
		createPlanRecord({ planId: "plan-a", title: "Plan A" }),
	);
	await fs.mkdirp(worktreePath);
	await initializePlanState(fs, planPaths, {
		...createInitialPlanState({
			baseBranch: "main",
			planBranch: "plan/plan-a",
			worktreePath,
		}),
		stage: "planning",
		step,
		stepStatus: "running",
		currentBranch: "plan/plan-a",
	});
	await setActivePlan(fs, projectPaths, "plan-a");
	return { fs, projectPaths, planPaths };
}

describe("planner elenchus tool", () => {
	it("runs a check and reports CONFLICT with a verdict loop hint", async () => {
		const setup = await createSetup();
		const result = await executePlannerElenchusTool({
			fs: setup.fs,
			git,
			projectPaths: setup.projectPaths,
			params: {
				name: "Owner Check",
				resolution: "checked",
				program: "DOMAIN d\nFACT x a\nNOT x a\nCHECK x",
			},
		});

		expect(result.status).toBe("applied");
		expect(result.details?.verdict).toBe("CONFLICT");
		expect(result.text).toContain("planner_finish_step is blocked");
		// Source and verdict are persisted under the plan's elenchus dir.
		const source = await setup.fs.readText(
			join(setup.planPaths.elenchusDir, "owner-check.vrf"),
		);
		expect(source).toContain("CHECK x");
		const verdict = await setup.fs.readText(
			join(setup.planPaths.elenchusDir, "owner-check.result.json"),
		);
		expect(verdict).toContain('"status":"CONFLICT"');
	});

	it("reports CONSISTENT for a satisfiable program", async () => {
		const setup = await createSetup();
		const result = await executePlannerElenchusTool({
			fs: setup.fs,
			git,
			projectPaths: setup.projectPaths,
			params: {
				name: "ok",
				resolution: "checked",
				program: "DOMAIN d\nFACT x a\nCHECK x",
			},
		});
		expect(result.status).toBe("applied");
		expect(result.details?.verdict).toBe("CONSISTENT");
		expect(result.text).toContain("CONSISTENT (exit 0)");
	});

	it("resolves multi-file IMPORT through the elenchus dir", async () => {
		const setup = await createSetup();
		// A sibling source the entry program imports — as if written by an earlier
		// planner_elenchus_check call.
		await setup.fs.writeTextAtomic(
			join(setup.planPaths.elenchusDir, "physics.vrf"),
			[
				"DOMAIN physics",
				"PREMISE fast_xor_slow:",
				"    EXCLUSIVE",
				"        Motor uses fast_path",
				"        Motor uses slow_path",
				"",
			].join("\n"),
		);
		const result = await executePlannerElenchusTool({
			fs: setup.fs,
			git,
			projectPaths: setup.projectPaths,
			params: {
				name: "import-check",
				resolution: "checked",
				program: [
					"DOMAIN demo",
					'IMPORT "physics.vrf"',
					"FACT physics.Motor uses fast_path",
					"FACT physics.Motor uses slow_path",
					"CHECK",
				].join("\n"),
			},
		});
		expect(result.status).toBe("applied");
		expect(result.details?.verdict).toBe("CONFLICT");
	});

	it("binds VAR ports through the values parameter", async () => {
		const setup = await createSetup();
		const program = [
			"DOMAIN deploy",
			"VAR tests_green",
			"VAR db_migrated DEFAULT false",
			"PREMISE gate:",
			"    WHEN tests_green",
			"    AND  db_migrated",
			"    THEN ship a",
			"NOT ship a",
			"CHECK",
		].join("\n");
		// Ports unset: the gate cannot fire, so the deny stands (no conflict).
		const open = await executePlannerElenchusTool({
			fs: setup.fs,
			git,
			projectPaths: setup.projectPaths,
			params: { name: "gate-open", resolution: "checked", program },
		});
		expect(open.status).toBe("applied");
		expect(open.details?.verdict).not.toBe("CONFLICT");

		// Both ports supplied true: the gate fires and clashes with `NOT ship a`.
		const fired = await executePlannerElenchusTool({
			fs: setup.fs,
			git,
			projectPaths: setup.projectPaths,
			params: {
				name: "gate-fired",
				resolution: "checked",
				program,
				values: { tests_green: true, db_migrated: true },
			},
		});
		expect(fired.status).toBe("applied");
		expect(fired.details?.verdict).toBe("CONFLICT");
	});

	it("blocks a non-boolean values entry", async () => {
		const setup = await createSetup();
		const result = await executePlannerElenchusTool({
			fs: setup.fs,
			git,
			projectPaths: setup.projectPaths,
			params: {
				name: "bad-values",
				resolution: "checked",
				program: "DOMAIN d\nVAR p\nFACT x a\nCHECK x",
				values: { p: "yes" },
			},
		});
		expect(result.status).toBe("blocked");
		expect(result.text).toContain("values");
	});

	it("auto-syncs the template library so IMPORT templates/... resolves", async () => {
		const setup = await createSetup();
		const result = await executePlannerElenchusTool({
			fs: setup.fs,
			git,
			projectPaths: setup.projectPaths,
			params: {
				name: "plan-gate",
				resolution: "checked",
				program: [
					"DOMAIN check",
					'IMPORT "templates/plan-consistency.vrf"',
					"FACT plan_consistency.plan is_ready",
					"NOT  plan_consistency.plan has_dependencies",
					"NOT  plan_consistency.plan touches_public_api",
					"CHECK",
				].join("\n"),
				values: {
					goal_approved: true,
					tasks_cover_goal: true,
					every_task_has_file: true,
					no_open_questions: true,
				},
			},
		});
		expect(result.status).toBe("applied");
		expect(result.details?.verdict).toBe("CONSISTENT");
		// The library landed inside the plan's elenchus dir (sandbox intact).
		expect(
			await setup.fs.exists(
				join(setup.planPaths.elenchusDir, "templates", "plan-consistency.vrf"),
			),
		).toBe(true);
	});

	it("records the not_applicable escape without running the engine", async () => {
		const setup = await createSetup();
		const result = await executePlannerElenchusTool({
			fs: setup.fs,
			git,
			projectPaths: setup.projectPaths,
			params: {
				name: "linear",
				resolution: "not_applicable",
				reason: "Pure CRUD task with no interacting constraints.",
			},
		});
		expect(result.status).toBe("applied");
		expect(result.details?.resolution).toBe("not_applicable");
		const record = await setup.fs.readText(
			join(setup.planPaths.elenchusDir, "linear.not-applicable.md"),
		);
		expect(record).toContain("Pure CRUD task");
	});

	it("blocks not_applicable without a reason", async () => {
		const setup = await createSetup();
		const result = await executePlannerElenchusTool({
			fs: setup.fs,
			git,
			projectPaths: setup.projectPaths,
			params: { name: "x", resolution: "not_applicable" },
		});
		expect(result.status).toBe("blocked");
		expect(result.text).toContain("reason");
	});

	it("is blocked at a step that does not allow it", async () => {
		const setup = await createSetup("draft_plan");
		const result = await executePlannerElenchusTool({
			fs: setup.fs,
			git,
			projectPaths: setup.projectPaths,
			params: {
				name: "x",
				resolution: "checked",
				program: "DOMAIN d\nFACT x a\nCHECK x",
			},
		});
		expect(result.status).toBe("blocked");
	});
});
