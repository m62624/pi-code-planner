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
import {
	type TaskBehavior,
	validateTaskBehaviors,
	writeTaskBehaviors,
} from "../storage/behavior-store";
import { createNodeFs } from "../storage/fs";
import {
	createPlanStoragePaths,
	createProjectStoragePaths,
	createTaskStoragePaths,
} from "../storage/paths";
import { initializePlanFiles } from "../storage/plan-store";
import { ensureProjectRecord, setActivePlan } from "../storage/project-store";
import {
	createInitialPlanState,
	createPlanRecord,
	type PlannerStep,
} from "../storage/schema";
import { initializePlanState } from "../storage/state-store";
import { executePlannerReasonTool } from "./reason-tools";

// The orchestrator preflight inspects the current branch; the mock reports the
// active plan branch as clean. (Mirrors elenchus-tools.test.ts.)
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

async function createSetup(
	step: PlannerStep = "consistency_check",
	stage: "planning" | "execution" = "planning",
	activeTaskId: string | null = null,
) {
	const root = await mkdtemp(join(tmpdir(), "reason-tools-"));
	tempDirs.push(root);
	const fs = createNodeFs();
	const projectPaths = createProjectStoragePaths({
		agentDir: join(root, "agent"),
		projectRoot: join(root, "repo"),
	});
	const planPaths = createPlanStoragePaths(projectPaths, "plan-a");
	const worktreePath = join(
		root,
		"repo",
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
	await fs.mkdirp(planPaths.elenchusDir);
	await initializePlanState(fs, planPaths, {
		...createInitialPlanState({
			baseBranch: "main",
			planBranch: "plan/plan-a",
			worktreePath,
		}),
		stage,
		step,
		stepStatus: "running",
		currentBranch: "plan/plan-a",
		activeTaskId,
	});
	await setActivePlan(fs, projectPaths, "plan-a");
	return { fs, projectPaths, planPaths, projectRoot: join(root, "repo") };
}

function run(setup: { fs: unknown; projectPaths: unknown }, params: unknown) {
	return executePlannerReasonTool({
		fs: setup.fs as never,
		git,
		projectPaths: setup.projectPaths as never,
		params,
	});
}

describe("planner_reason tool", () => {
	it("reports a CONSISTENT verdict and suppresses the raw engine dump", async () => {
		const setup = await createSetup();
		const result = await run(setup, {
			mode: "assert",
			domain: "discovery",
			statements: [{ vrf: "FACT cache is_lru" }],
		});
		expect(result.status).toBe("applied");
		expect(result.details?.verdict).toBe("CONSISTENT");
		expect(result.text).toContain("CONSISTENT");
		expect(result.text).toContain("world verdict");
		// On CONSISTENT the raw engine report (a big non-actionable JSON body) is
		// withheld — the verdict line already says all there is.
		expect(result.text).not.toContain('"exit_code"');
		expect(result.text).not.toContain('"derived"');
	});

	it("surfaces a CONFLICT with the finish_step block hint", async () => {
		const setup = await createSetup();
		const result = await run(setup, {
			mode: "assert",
			domain: "discovery",
			statements: [
				{ vrf: "FACT db is_postgres" },
				{ vrf: "ASSUME db is_sqlite" },
				{
					vrf: "PREMISE only_one:\n    EXCLUSIVE\n    db is_postgres\n    db is_sqlite",
				},
			],
		});
		expect(result.details?.verdict).toBe("CONFLICT");
		expect(result.text).toContain("CONFLICT");
		expect(result.text).toContain("planner_finish_step stays blocked");
		// When NOT consistent the raw engine report IS surfaced — it names what to
		// fix (the actionable direction the suppression must not touch).
		expect(result.text).toContain('"exit_code"');
	});

	it("retract removes a statement and re-checks; unknown ids are reported, never thrown", async () => {
		const setup = await createSetup();
		await run(setup, {
			mode: "assert",
			domain: "discovery",
			statements: [{ vrf: "FACT cache is_lru" }],
		});
		const removed = await run(setup, { mode: "retract", ids: ["w1"] });
		expect(removed.status).toBe("applied");
		expect(removed.details?.verdict).toBe("CONSISTENT");

		const missing = await run(setup, { mode: "retract", ids: ["w99"] });
		expect(missing.status).toBe("applied");
		expect(missing.text).toContain("No statements matched w99");
	});

	it("recheck re-runs the world as-is (an empty world is CONSISTENT)", async () => {
		const setup = await createSetup();
		const result = await run(setup, { mode: "recheck" });
		expect(result.status).toBe("applied");
		expect(result.details?.verdict).toBe("CONSISTENT");
	});

	it("anchors an observation to an existing file and rejects a missing one", async () => {
		const setup = await createSetup();
		await setup.fs.writeTextAtomic(
			join(setup.projectRoot, "src/cache.ts"),
			"export const CACHE = 'lru';\n",
		);
		const ok = await run(setup, {
			mode: "assert",
			domain: "discovery",
			statements: [{ vrf: "FACT cache is_lru", anchor: "src/cache.ts" }],
		});
		expect(ok.status).toBe("applied");

		const missing = await run(setup, {
			mode: "assert",
			domain: "discovery",
			statements: [{ vrf: "FACT gone observed", anchor: "src/nope.ts" }],
		});
		expect(missing.status).toBe("blocked");
		expect(missing.text).toContain("Cannot anchor");
	});

	it("rejects an instrument keyword with a mode hint", async () => {
		const setup = await createSetup();
		const result = await run(setup, {
			mode: "assert",
			domain: "discovery",
			statements: [{ vrf: "PROVE merge is_blocked" }],
		});
		expect(result.status).toBe("blocked");
		expect(result.text).toMatch(/instrument/i);
	});

	it("surfaces the reasoning-fuel directive once a web exists (execution branches)", async () => {
		const setup = await createExecSetupWithBranches(["BR-1", "BR-2"]);
		const result = await run(setup, {
			mode: "assert",
			domain: "task_a",
			statements: [{ vrf: "FACT br_1 covered" }, { vrf: "FACT br_2 covered" }],
		});
		expect(result.status).toBe("applied");
		// A model-authored run on a 2-branch step credits the full web ⇒ fuel 100.
		expect(result.details?.fuel).toBe(100);
		expect(result.text).toContain("Reasoning fuel: 100");
	});

	it("stays silent on fuel where no web is warranted (W=0)", async () => {
		const setup = await createSetup();
		const result = await run(setup, { mode: "recheck" });
		expect(result.details?.fuel).toBeNull();
		expect(result.text).not.toContain("Reasoning fuel");
	});
});

async function createExecSetupWithBranches(branchIds: string[]) {
	const setup = await createSetup("contract_check", "execution", "task-a");
	const behavior: TaskBehavior = {
		id: "BHV-1",
		statement: "Adds a dependency with cycle rejection",
		kind: "error",
		requirement: null,
		test: null,
		branches: branchIds.map((id) => ({
			id,
			condition: `${id} condition`,
			covered: false,
		})),
		status: "planned",
	};
	await writeTaskBehaviors(
		setup.fs,
		createTaskStoragePaths(setup.planPaths, "task-a"),
		validateTaskBehaviors({
			taskId: "task-a",
			behaviors: [behavior],
			previous: null,
		}),
	);
	return setup;
}
