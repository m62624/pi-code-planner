import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { NodeGitRunner } from "../git/node-runner";
import { PROJECT_WORKTREES_IGNORE_RULE } from "../project-local/gitignore";
import { createNodeFs } from "../storage/fs";
import { createProjectStoragePaths } from "../storage/paths";
import {
	createPlanWorktree,
	WORKTREE_GITIGNORE_COMMIT_MESSAGE,
} from "./manager";
import { createProjectLocalWorktreeLocation } from "./paths";

const execFileAsync = promisify(execFile);

describe("worktree manager real git integration", () => {
	it("keeps the base checkout clean and commits the ignore rule on the plan branch", async () => {
		const projectRoot = await mkdtemp(join(tmpdir(), "pi-code-planner-"));
		try {
			await initializeRepository(projectRoot);

			const projectPaths = createProjectStoragePaths({
				agentDir: join(projectRoot, ".agent"),
				projectRoot,
			});
			const location = createProjectLocalWorktreeLocation(
				projectPaths,
				"plan-a",
			);
			const result = await createPlanWorktree({
				fs: createNodeFs(),
				git: new NodeGitRunner(),
				projectPaths,
				worktreePath: location.path,
				branch: "plan/plan-a",
				fromRef: "main",
			});

			expect(result.bootstrapCommit).toBe(WORKTREE_GITIGNORE_COMMIT_MESSAGE);
			expect(await gitOutput(projectRoot, "status", "--porcelain=v1")).toBe("");
			expect(await gitOutput(location.path, "status", "--porcelain=v1")).toBe(
				"",
			);
			expect(
				await gitOutput(projectRoot, "show", "plan/plan-a:.gitignore"),
			).toBe(PROJECT_WORKTREES_IGNORE_RULE);
			expect(
				await readFile(join(projectRoot, ".git", "info", "exclude"), "utf8"),
			).toContain(PROJECT_WORKTREES_IGNORE_RULE);
		} finally {
			await rm(projectRoot, { recursive: true, force: true });
		}
	});

	it("resolves the common exclude path when the source project is itself a linked worktree", async () => {
		const repositoryRoot = await mkdtemp(join(tmpdir(), "pi-code-planner-"));
		try {
			await initializeRepository(repositoryRoot);
			const linkedRoot = join(repositoryRoot, "linked");
			await runGit(
				repositoryRoot,
				"worktree",
				"add",
				"-b",
				"linked/base",
				linkedRoot,
				"main",
			);

			const projectPaths = createProjectStoragePaths({
				agentDir: join(repositoryRoot, ".agent"),
				projectRoot: linkedRoot,
			});
			const location = createProjectLocalWorktreeLocation(
				projectPaths,
				"plan-a",
			);
			await createPlanWorktree({
				fs: createNodeFs(),
				git: new NodeGitRunner(),
				projectPaths,
				worktreePath: location.path,
				branch: "plan/plan-a",
				fromRef: "linked/base",
			});

			expect(await gitOutput(linkedRoot, "status", "--porcelain=v1")).toBe("");
			expect(await gitOutput(location.path, "status", "--porcelain=v1")).toBe(
				"",
			);
			expect(
				await readFile(join(repositoryRoot, ".git", "info", "exclude"), "utf8"),
			).toContain(PROJECT_WORKTREES_IGNORE_RULE);
		} finally {
			await rm(repositoryRoot, { recursive: true, force: true });
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
