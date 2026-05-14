import { describe, expect, it } from "vitest";
import type { GitCommandResult, GitRunner } from "./runner";
import { RunnerGitWriter } from "./write";

class MockGitRunner implements GitRunner {
	calls: string[][] = [];

	async exec(_cwd: string, args: string[]): Promise<GitCommandResult> {
		this.calls.push(args);
		return { stdout: "", stderr: "" };
	}
}

function setup() {
	const runner = new MockGitRunner();
	const writer = new RunnerGitWriter(runner, "/repo");
	return { runner, writer };
}

describe("RunnerGitWriter", () => {
	it("initializes a repo", async () => {
		const { runner, writer } = setup();

		await writer.initRepo();

		expect(runner.calls).toEqual([["init"]]);
	});

	it("creates a branch", async () => {
		const { runner, writer } = setup();

		await writer.createBranch("planner/plan", "main");

		expect(runner.calls).toEqual([["branch", "planner/plan", "main"]]);
	});

	it("creates and switches to a branch", async () => {
		const { runner, writer } = setup();

		await writer.createAndSwitchBranch("planner/plan", "main");

		expect(runner.calls).toEqual([["switch", "-c", "planner/plan", "main"]]);
	});

	it("switches branches", async () => {
		const { runner, writer } = setup();

		await writer.switchBranch("planner/plan");

		expect(runner.calls).toEqual([["switch", "planner/plan"]]);
	});

	it("deletes branches safely by default", async () => {
		const { runner, writer } = setup();

		await writer.deleteBranch("planner/plan/work/parser");

		expect(runner.calls).toEqual([
			["branch", "-d", "planner/plan/work/parser"],
		]);
	});

	it("supports force branch deletion only when requested", async () => {
		const { runner, writer } = setup();

		await writer.deleteBranch("planner/plan/work/parser", { force: true });

		expect(runner.calls).toEqual([
			["branch", "-D", "planner/plan/work/parser"],
		]);
	});

	it("stages selected files behind --", async () => {
		const { runner, writer } = setup();

		await writer.stageFiles(["src/a.ts", "src/b.ts"]);

		expect(runner.calls).toEqual([["add", "--", "src/a.ts", "src/b.ts"]]);
	});

	it("stages all files", async () => {
		const { runner, writer } = setup();

		await writer.stageAll();

		expect(runner.calls).toEqual([["add", "--all"]]);
	});

	it("unstages selected files", async () => {
		const { runner, writer } = setup();

		await writer.unstageFiles(["src/a.ts"]);

		expect(runner.calls).toEqual([["restore", "--staged", "--", "src/a.ts"]]);
	});

	it("commits with a message", async () => {
		const { runner, writer } = setup();

		await writer.commit("feat: add parser");

		expect(runner.calls).toEqual([["commit", "-m", "feat: add parser"]]);
	});

	it("merges branches with options", async () => {
		const { runner, writer } = setup();

		await writer.mergeBranch("planner/plan/work/parser", {
			noFastForward: true,
			message: "merge parser work item",
		});

		expect(runner.calls).toEqual([
			[
				"merge",
				"--no-ff",
				"-m",
				"merge parser work item",
				"planner/plan/work/parser",
			],
		]);
	});

	it("soft resets to a ref", async () => {
		const { runner, writer } = setup();

		await writer.softReset("HEAD~1");

		expect(runner.calls).toEqual([["reset", "--soft", "HEAD~1"]]);
	});

	it("hard resets to a ref", async () => {
		const { runner, writer } = setup();

		await writer.hardReset("abc123");

		expect(runner.calls).toEqual([["reset", "--hard", "abc123"]]);
	});

	it("rejects empty branch names", async () => {
		const { writer } = setup();

		expect(() => writer.switchBranch(" ")).toThrow(
			"Git write field is required: branchName",
		);
	});

	it("rejects empty file lists", async () => {
		const { writer } = setup();

		expect(() => writer.stageFiles([])).toThrow(
			"Git write field is required: files",
		);
	});

	it("rejects empty commit messages", async () => {
		const { writer } = setup();

		expect(() => writer.commit(" ")).toThrow(
			"Git write field is required: message",
		);
	});
});
