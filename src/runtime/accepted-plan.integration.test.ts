import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { NodeGitRunner } from "../git/node-runner";
import { createNodeFs } from "../storage/fs";
import {
	createPlanStoragePaths,
	createProjectStoragePaths,
} from "../storage/paths";
import { initializePlanFiles } from "../storage/plan-store";
import {
	ensureProjectRecord,
	readProjectRecord,
	setActivePlan,
	upsertProjectPlanSummary,
} from "../storage/project-store";
import { createInitialPlanState, createPlanRecord } from "../storage/schema";
import { initializePlanState } from "../storage/state-store";
import { saveWorktreeProjectIndex } from "../storage/worktree-index";
import { createPlanWorktree } from "../worktree/manager";
import { createProjectLocalWorktreeLocation } from "../worktree/paths";
import { finalizeAcceptedPlan } from "./accepted-plan";

const execFileAsync = promisify(execFile);

describe("accepted planner result real git integration", () => {
	it("leaves one output branch and removes the temporary plan worktree", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "pi-code-planner-accept-"));
		const projectRoot = join(workspace, "project");
		const agentDir = join(workspace, "agent");
		try {
			await mkdir(projectRoot);
			await initializeRepository(projectRoot);
			const fs = createNodeFs();
			const git = new NodeGitRunner();
			const projectPaths = createProjectStoragePaths({
				agentDir,
				projectRoot,
			});
			const location = createProjectLocalWorktreeLocation(
				projectPaths,
				"plan-a",
			);
			await createPlanWorktree({
				fs,
				git,
				projectPaths,
				worktreePath: location.path,
				branch: "plan/plan-a",
				fromRef: "main",
			});

			const planPaths = createPlanStoragePaths(projectPaths, "plan-a");
			await ensureProjectRecord(fs, projectPaths);
			await initializePlanFiles(
				fs,
				planPaths,
				createPlanRecord({ planId: "plan-a", title: "Plan A" }),
			);
			const initialState = createInitialPlanState({
				baseBranch: "main",
				planBranch: "plan/plan-a",
				worktreePath: location.path,
			});
			await initializePlanState(fs, planPaths, {
				...initialState,
				stage: "done",
				step: "await_user_acceptance",
				stepStatus: "running",
				currentBranch: "plan/plan-a",
			});
			await upsertProjectPlanSummary(fs, projectPaths, {
				planId: "plan-a",
				title: "Plan A",
				status: "active",
			});
			await setActivePlan(fs, projectPaths, "plan-a");
			const originalSessionFile = join(agentDir, "sessions", "original.jsonl");
			await fs.writeTextAtomic(originalSessionFile, "{}\n");
			await saveWorktreeProjectIndex({
				fs,
				agentDir,
				record: {
					schemaVersion: 1,
					worktreePath: location.path,
					projectRoot,
					projectId: projectPaths.projectId,
					planId: "plan-a",
					originalSessionFile,
				},
			});

			await finalizeAcceptedPlan({ fs, git, projectPaths });

			expect(await gitOutput(projectRoot, "branch", "--show-current")).toBe(
				"output/plan-a",
			);
			expect(
				await gitOutput(projectRoot, "branch", "--list", "plan/plan-a"),
			).toBe("");
			expect(await gitOutput(projectRoot, "status", "--porcelain=v1")).toBe("");
			await expect(fs.exists(location.path)).resolves.toBe(false);
			await expect(fs.exists(planPaths.planDir)).resolves.toBe(false);
			await expect(readProjectRecord(fs, projectPaths)).resolves.toMatchObject({
				activePlanId: null,
				plans: [],
			});
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});
});

async function initializeRepository(projectRoot: string): Promise<void> {
	await runGit(projectRoot, "init");
	await runGit(projectRoot, "config", "user.name", "Pi Code Planner Test");
	await runGit(
		projectRoot,
		"config",
		"user.email",
		"pi-code-planner@example.invalid",
	);
	await writeFile(join(projectRoot, "README.md"), "# Test\n", "utf8");
	await runGit(projectRoot, "add", "README.md");
	await runGit(projectRoot, "commit", "-m", "initial");
	await runGit(projectRoot, "branch", "-M", "main");
}

async function runGit(cwd: string, ...args: string[]): Promise<void> {
	await execFileAsync("git", ["-C", cwd, ...args]);
}

async function gitOutput(cwd: string, ...args: string[]): Promise<string> {
	const result = await execFileAsync("git", ["-C", cwd, ...args]);
	return result.stdout.trimEnd();
}
