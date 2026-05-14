import { describe, expect, it } from "vitest";
import type { GitCommandResult, GitRunner } from "./runner";
import {
	getBranchState,
	getCurrentBranch,
	getCurrentCommit,
	getRepoRoot,
	getRepoState,
	getRepoStatus,
} from "./state";

class MockGitRunner implements GitRunner {
	calls: string[][] = [];

	constructor(private responses: Map<string, GitCommandResult | Error>) {}

	async exec(_cwd: string, args: string[]): Promise<GitCommandResult> {
		this.calls.push(args);
		const key = args.join(" ");
		const response = this.responses.get(key);
		if (!response) {
			throw new Error(`Unexpected git command: ${key}`);
		}
		if (response instanceof Error) {
			throw response;
		}
		return response;
	}
}

function result(stdout: string): GitCommandResult {
	return { stdout, stderr: "" };
}

describe("git state readers", () => {
	it("returns repo root when git rev-parse succeeds", async () => {
		const runner = new MockGitRunner(
			new Map([["rev-parse --show-toplevel", result("/repo\n")]]),
		);

		await expect(getRepoRoot(runner, "/repo")).resolves.toBe("/repo");
	});

	it("returns null repo root when git rev-parse fails", async () => {
		const runner = new MockGitRunner(
			new Map([["rev-parse --show-toplevel", new Error("not git")]]),
		);

		await expect(getRepoRoot(runner, "/repo")).resolves.toBeNull();
	});

	it("reads current branch", async () => {
		const runner = new MockGitRunner(
			new Map([["rev-parse --abbrev-ref HEAD", result("main\n")]]),
		);

		await expect(getCurrentBranch(runner, "/repo")).resolves.toBe("main");
	});

	it("normalizes detached HEAD into branch state", async () => {
		const runner = new MockGitRunner(
			new Map([["rev-parse --abbrev-ref HEAD", result("HEAD\n")]]),
		);

		await expect(getBranchState(runner, "/repo")).resolves.toEqual({
			currentBranch: null,
			isDetachedHead: true,
		});
	});

	it("reads current commit", async () => {
		const runner = new MockGitRunner(
			new Map([["rev-parse HEAD", result("abc123\n")]]),
		);

		await expect(getCurrentCommit(runner, "/repo")).resolves.toBe("abc123");
	});

	it("returns null current commit when repo has no commits", async () => {
		const runner = new MockGitRunner(
			new Map([["rev-parse HEAD", new Error("no commits")]]),
		);

		await expect(getCurrentCommit(runner, "/repo")).resolves.toBeNull();
	});

	it("reads and parses repo status", async () => {
		const runner = new MockGitRunner(
			new Map([["status --porcelain", result(" M src/a.ts\n?? src/new.ts\n")]]),
		);

		const status = await getRepoStatus(runner, "/repo");

		expect(status.unstagedFiles).toEqual(["src/a.ts"]);
		expect(status.untrackedFiles).toEqual(["src/new.ts"]);
	});

	it("returns non-repo state when repo root is missing", async () => {
		const runner = new MockGitRunner(
			new Map([["rev-parse --show-toplevel", new Error("not git")]]),
		);

		const state = await getRepoState(runner, "/repo");

		expect(state).toMatchObject({
			cwd: "/repo",
			repoRoot: null,
			isRepo: false,
			currentBranch: null,
			currentCommit: null,
			isDetachedHead: false,
		});
		expect(state.status.isDirty).toBe(false);
	});

	it("returns full clean repo state", async () => {
		const runner = new MockGitRunner(
			new Map([
				["rev-parse --show-toplevel", result("/repo\n")],
				["rev-parse --abbrev-ref HEAD", result("main\n")],
				["rev-parse HEAD", result("abc123\n")],
				["status --porcelain", result("")],
			]),
		);

		const state = await getRepoState(runner, "/repo");

		expect(state).toMatchObject({
			repoRoot: "/repo",
			isRepo: true,
			currentBranch: "main",
			currentCommit: "abc123",
			isDetachedHead: false,
		});
		expect(state.status.isDirty).toBe(false);
	});

	it("returns full dirty repo state", async () => {
		const runner = new MockGitRunner(
			new Map([
				["rev-parse --show-toplevel", result("/repo\n")],
				["rev-parse --abbrev-ref HEAD", result("feature\n")],
				["rev-parse HEAD", result("def456\n")],
				["status --porcelain", result("M  src/a.ts\n M src/b.ts\n")],
			]),
		);

		const state = await getRepoState(runner, "/repo");

		expect(state.currentBranch).toBe("feature");
		expect(state.status.stagedFiles).toEqual(["src/a.ts"]);
		expect(state.status.unstagedFiles).toEqual(["src/b.ts"]);
		expect(state.status.isDirty).toBe(true);
	});

	it("marks detached HEAD state", async () => {
		const runner = new MockGitRunner(
			new Map([
				["rev-parse --show-toplevel", result("/repo\n")],
				["rev-parse --abbrev-ref HEAD", result("HEAD\n")],
				["rev-parse HEAD", result("abc123\n")],
				["status --porcelain", result("")],
			]),
		);

		const state = await getRepoState(runner, "/repo");

		expect(state.isDetachedHead).toBe(true);
		expect(state.currentBranch).toBeNull();
	});
});
