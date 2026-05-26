import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../constants";
import { MockPlannerFs } from "../test/mock-fs";
import { createProjectStoragePaths } from "./paths";
import { resolveProjectStoragePaths } from "./project-resolver";
import { ensureProjectRecord } from "./project-store";
import {
	readWorktreeProjectIndexIfExists,
	saveWorktreeProjectIndex,
} from "./worktree-index";

describe("project storage resolver", () => {
	it("returns direct project paths when cwd has a project record", async () => {
		const fs = new MockPlannerFs();
		const direct = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		await ensureProjectRecord(fs, direct);

		const resolved = await resolveProjectStoragePaths({
			fs,
			agentDir: "/agent",
			cwd: "/repo/app",
		});

		expect(resolved.projectRoot).toBe("/repo/app");
		expect(resolved.projectId).toBe(direct.projectId);
	});

	it("maps planner worktree cwd back to the original project paths", async () => {
		const fs = new MockPlannerFs();
		const original = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		await saveWorktreeProjectIndex({
			fs,
			agentDir: "/agent",
			record: {
				schemaVersion: SCHEMA_VERSION,
				worktreePath: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
				projectRoot: "/repo/app",
				projectId: original.projectId,
				planId: "plan-a",
			},
		});

		const resolved = await resolveProjectStoragePaths({
			fs,
			agentDir: "/agent",
			cwd: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
		});

		expect(resolved.projectRoot).toBe("/repo/app");
		expect(resolved.projectId).toBe(original.projectId);
	});

	it("preserves the original session file in the worktree index", async () => {
		const fs = new MockPlannerFs();

		await saveWorktreeProjectIndex({
			fs,
			agentDir: "/agent",
			record: {
				schemaVersion: SCHEMA_VERSION,
				worktreePath: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
				projectRoot: "/repo/app",
				projectId: "app-123",
				planId: "plan-a",
				originalSessionFile: "/agent/sessions/--repo-app--/parent.jsonl",
			},
		});

		await expect(
			readWorktreeProjectIndexIfExists({
				fs,
				agentDir: "/agent",
				worktreePath: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
			}),
		).resolves.toMatchObject({
			planId: "plan-a",
			projectRoot: "/repo/app",
			originalSessionFile: "/agent/sessions/--repo-app--/parent.jsonl",
		});
	});
});
