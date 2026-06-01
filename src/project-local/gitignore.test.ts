import { describe, expect, it } from "vitest";
import { MockPlannerFs } from "../test/mock-fs";
import {
	ensureProjectWorktreesIgnored,
	ensureProjectWorktreesLocallyExcluded,
	hasExactWorktreesIgnoreRule,
	PROJECT_WORKTREES_IGNORE_RULE,
} from "./gitignore";

describe("project worktree gitignore rule", () => {
	it("creates .gitignore when it is missing", async () => {
		const fs = new MockPlannerFs();

		const result = await ensureProjectWorktreesIgnored(fs, "/repo/app");

		expect(result).toEqual({
			path: "/repo/app/.gitignore",
			rule: PROJECT_WORKTREES_IGNORE_RULE,
			action: "created",
		});
		expect(fs.snapshot()["/repo/app/.gitignore"]).toBe(
			".pi/pi-code-planner/worktrees/\n",
		);
	});

	it("appends the worktree rule when .gitignore exists without it", async () => {
		const fs = new MockPlannerFs();
		await fs.writeTextAtomic("/repo/app/.gitignore", "node_modules/\ndist/");

		const result = await ensureProjectWorktreesIgnored(fs, "/repo/app");

		expect(result.action).toBe("appended");
		expect(fs.snapshot()["/repo/app/.gitignore"]).toBe(
			"node_modules/\ndist/\n.pi/pi-code-planner/worktrees/\n",
		);
	});

	it("writes the same exact rule to the repository-local exclude file", async () => {
		const fs = new MockPlannerFs();

		const result = await ensureProjectWorktreesLocallyExcluded(fs, "/repo/app");

		expect(result).toEqual({
			path: "/repo/app/.git/info/exclude",
			rule: PROJECT_WORKTREES_IGNORE_RULE,
			action: "created",
		});
		expect(fs.snapshot()["/repo/app/.git/info/exclude"]).toBe(
			".pi/pi-code-planner/worktrees/\n",
		);
	});

	it("does not duplicate an existing exact rule", async () => {
		const fs = new MockPlannerFs();
		await fs.writeTextAtomic(
			"/repo/app/.gitignore",
			"node_modules/\n.pi/pi-code-planner/worktrees/\n",
		);

		const result = await ensureProjectWorktreesIgnored(fs, "/repo/app");

		expect(result.action).toBe("unchanged");
		expect(fs.snapshot()["/repo/app/.gitignore"]).toBe(
			"node_modules/\n.pi/pi-code-planner/worktrees/\n",
		);
	});

	it("treats ./ prefixed rule as the same exact rule", async () => {
		const fs = new MockPlannerFs();
		await fs.writeTextAtomic(
			"/repo/app/.gitignore",
			"./.pi/pi-code-planner/worktrees/\n",
		);

		const result = await ensureProjectWorktreesIgnored(fs, "/repo/app");

		expect(result.action).toBe("unchanged");
		expect(fs.snapshot()["/repo/app/.gitignore"]).toBe(
			"./.pi/pi-code-planner/worktrees/\n",
		);
	});

	it("does not use substring matching for broader .pi rules or comments", () => {
		expect(hasExactWorktreesIgnoreRule(".pi/\n")).toBe(false);
		expect(
			hasExactWorktreesIgnoreRule("# .pi/pi-code-planner/worktrees/\n"),
		).toBe(false);
		expect(
			hasExactWorktreesIgnoreRule(".pi/pi-code-planner/worktrees-old/\n"),
		).toBe(false);
		expect(
			hasExactWorktreesIgnoreRule(" ./.pi/pi-code-planner/worktrees/ "),
		).toBe(true);
	});
});
