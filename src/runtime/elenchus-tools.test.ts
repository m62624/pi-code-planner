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
		expect(result.text).toContain("Not CONSISTENT yet");
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
