import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../constants";
import { MockPlannerFs } from "../test/mock-fs";
import { createProjectStoragePaths } from "./paths";
import { resolveProjectStoragePaths } from "./project-resolver";
import { ensureProjectRecord } from "./project-store";
import {
	bindWorktreeRootSession,
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

	it("preserves root session files in the worktree index", async () => {
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
				createdFromSessionFile: "/agent/sessions/--repo-app--/parent.jsonl",
				lastRootSessionFile: "/agent/sessions/--repo-app--/parent.jsonl",
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
			createdFromSessionFile: "/agent/sessions/--repo-app--/parent.jsonl",
			lastRootSessionFile: "/agent/sessions/--repo-app--/parent.jsonl",
		});
	});

	it("binds a root session after a low-level plan tool created the index", async () => {
		const fs = new MockPlannerFs();
		const worktreePath = "/repo/app/.pi/pi-code-planner/worktrees/plan-a";
		await saveWorktreeProjectIndex({
			fs,
			agentDir: "/agent",
			record: {
				schemaVersion: SCHEMA_VERSION,
				worktreePath,
				projectRoot: "/repo/app",
				projectId: "app-123",
				planId: "plan-a",
			},
		});

		await bindWorktreeRootSession({
			fs,
			agentDir: "/agent",
			worktreePath,
			projectRoot: "/repo/app",
			projectId: "app-123",
			planId: "plan-a",
			createdFromSessionFile: "/agent/sessions/--repo-app--/root.jsonl",
			lastRootSessionFile: "/agent/sessions/--repo-app--/root.jsonl",
		});

		await expect(
			readWorktreeProjectIndexIfExists({
				fs,
				agentDir: "/agent",
				worktreePath,
			}),
		).resolves.toMatchObject({
			createdFromSessionFile: "/agent/sessions/--repo-app--/root.jsonl",
			lastRootSessionFile: "/agent/sessions/--repo-app--/root.jsonl",
		});
	});

	it("keeps the created-from session and updates only the last root session on resume", async () => {
		const fs = new MockPlannerFs();
		const worktreePath = "/repo/app/.pi/pi-code-planner/worktrees/plan-a";
		await bindWorktreeRootSession({
			fs,
			agentDir: "/agent",
			worktreePath,
			projectRoot: "/repo/app",
			projectId: "app-123",
			planId: "plan-a",
			createdFromSessionFile: "/agent/sessions/--repo-app--/created.jsonl",
			lastRootSessionFile: "/agent/sessions/--repo-app--/created.jsonl",
		});

		await bindWorktreeRootSession({
			fs,
			agentDir: "/agent",
			worktreePath,
			projectRoot: "/repo/app",
			projectId: "app-123",
			planId: "plan-a",
			lastRootSessionFile: "/agent/sessions/--repo-app--/latest.jsonl",
		});

		await expect(
			readWorktreeProjectIndexIfExists({
				fs,
				agentDir: "/agent",
				worktreePath,
			}),
		).resolves.toMatchObject({
			createdFromSessionFile: "/agent/sessions/--repo-app--/created.jsonl",
			lastRootSessionFile: "/agent/sessions/--repo-app--/latest.jsonl",
		});
	});

	it("falls back to scanning extensionDir/projects when worktree index is missing", async () => {
		const fs = new MockPlannerFs();
		const original = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		await ensureProjectRecord(fs, original);

		// cwd is inside a worktree directory but no worktree index exists
		const resolved = await resolveProjectStoragePaths({
			fs,
			agentDir: "/agent",
			cwd: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
		});

		expect(resolved.projectRoot).toBe("/repo/app");
		expect(resolved.projectId).toBe(original.projectId);
	});

	it("does not reuse an unrelated existing project for a new cwd", async () => {
		const fs = new MockPlannerFs();
		const existing = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/pi-planner",
		});
		await ensureProjectRecord(fs, existing);

		const resolved = await resolveProjectStoragePaths({
			fs,
			agentDir: "/agent",
			cwd: "/repo/approx_int",
		});

		expect(resolved.projectRoot).toBe("/repo/approx_int");
		expect(resolved.projectId).not.toBe(existing.projectId);
	});

	it("infers project root from project-local worktree cwd without using unrelated records", async () => {
		const fs = new MockPlannerFs();
		const unrelated = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/pi-planner",
		});
		await ensureProjectRecord(fs, unrelated);

		const resolved = await resolveProjectStoragePaths({
			fs,
			agentDir: "/agent",
			cwd: "/repo/app/.pi/pi-code-planner/worktrees/plan-a/src",
		});

		expect(resolved.projectRoot).toBe("/repo/app");
		expect(resolved.projectId).not.toBe(unrelated.projectId);
	});
});
