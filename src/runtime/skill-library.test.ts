import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../constants";
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
	createPlanStoragePaths,
	createProjectStoragePaths,
} from "../storage/paths";
import { initializePlanFiles } from "../storage/plan-store";
import { ensureProjectRecord, setActivePlan } from "../storage/project-store";
import { createInitialPlanState, createPlanRecord } from "../storage/schema";
import { initializePlanState } from "../storage/state-store";
import { saveWorktreeProjectIndex } from "../storage/worktree-index";
import { MockPlannerFs } from "../test/mock-fs";
import {
	createPlannerSkillStoragePaths,
	deletePlannerSkill,
	executePlannerSkillTool,
	listActivePlannerSkillPaths,
	listActivePlannerSkillPathsForCwd,
	listActivePlannerSkillSummaries,
	listPlannerSkillInventory,
	listPlannerSkillResourcePaths,
	validatePlannerSkillMarkdown,
} from "./skill-library";

class MockGitRunner implements GitRunner {
	async init(_input: GitRepoInput): Promise<void> {}
	async currentBranch(_input: GitRepoInput): Promise<string> {
		return "plan/plan-a";
	}
	async headCommit(_input: GitRepoInput): Promise<string> {
		return "abc123";
	}
	async hasCommits(_input: GitRepoInput): Promise<boolean> {
		return true;
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

describe("planner skill library", () => {
	it("creates a validated Pi skill and indexes it", async () => {
		const { fs, git, projectPaths } = await createSkillSetup();
		await fs.writeTextAtomic(
			"/agent/extensions/pi-code-planner/settings.json",
			'{ "metadata": { "skillLanguage": "Russian" } }\n',
		);

		const result = await executePlannerSkillTool({
			fs,
			git,
			projectPaths,
			uuid: "12345678-1234-1234-1234-123456789abc",
			now: 1000,
			params: {
				nameHint: "Stale ctx session switch",
				description:
					"ACTIVATE when a Pi extension switches sessions and follow-up messages may use stale ctx.",
				bodyMarkdown: [
					"# Stale Ctx Session Switch",
					"",
					"## Workflow",
					"",
					"- Treat switch handlers as terminal.",
					"- Use replacement context for follow-up messages.",
				].join("\n"),
				tags: ["Pi Extension", "ctx"],
				sourceKind: "debug",
				sourcePlanId: "plan-a",
				sourceTaskId: "task-a",
			},
		});

		expect(result.status).toBe("applied");
		expect(result.details?.item.name).toBe(
			"pi-planner-stale-ctx-session-switch-12345678",
		);
		const skills = createPlannerSkillStoragePaths(projectPaths);
		const createdPath = `${skills.libraryDir}/pi-planner-stale-ctx-session-switch-12345678/SKILL.md`;
		expect(fs.snapshot()[createdPath]).toContain(
			"description: >\n  ACTIVATE when a Pi extension switches",
		);
		expect(fs.snapshot()[skills.indexJson]).toContain('"language": "Russian"');

		await expect(
			listActivePlannerSkillPaths({ fs, projectPaths }),
		).resolves.toEqual([createdPath]);
	});

	it("rejects skill bodies that include frontmatter", async () => {
		const { fs, git, projectPaths } = await createSkillSetup();

		const result = await executePlannerSkillTool({
			fs,
			git,
			projectPaths,
			params: {
				nameHint: "bad",
				description: "ACTIVATE when testing invalid frontmatter.",
				bodyMarkdown: "---\nname: bad\n---\n# Bad",
				sourceKind: "other",
			},
		});

		expect(result.status).toBe("blocked");
		expect(result.text).toContain("must not include YAML frontmatter");
	});

	it("loads planner skills from the original project when cwd is a resumed worktree", async () => {
		const customWorktreePath = "/tmp/pi-worktrees/plan-a";
		const { fs, git, projectPaths } = await createSkillSetup({
			worktreePath: customWorktreePath,
		});
		await saveWorktreeProjectIndex({
			fs,
			agentDir: "/agent",
			record: {
				schemaVersion: SCHEMA_VERSION,
				worktreePath: customWorktreePath,
				projectRoot: projectPaths.projectRoot,
				projectId: projectPaths.projectId,
				planId: "plan-a",
			},
		});

		const created = await executePlannerSkillTool({
			fs,
			git,
			projectPaths,
			uuid: "87654321-1234-1234-1234-123456789abc",
			now: 1000,
			params: {
				nameHint: "Resume worktree skills",
				description:
					"ACTIVATE when planner resume switches into a worktree and skill discovery must use the original project storage.",
				bodyMarkdown:
					"# Resume Worktree Skills\n\nRead skills from the project that owns the worktree.",
				tags: ["resume", "skills"],
				sourceKind: "debug",
				sourcePlanId: "plan-a",
			},
		});

		expect(created.status).toBe("applied");
		await expect(
			listActivePlannerSkillPathsForCwd({
				fs,
				agentDir: "/agent",
				cwd: customWorktreePath,
			}),
		).resolves.toEqual([created.details?.skillPath]);
	});

	it("prepends the system elenchus skill ahead of project skills on resume", async () => {
		const customWorktreePath = "/tmp/pi-worktrees/plan-a";
		const { fs, projectPaths } = await createSkillSetup({
			worktreePath: customWorktreePath,
		});
		await saveWorktreeProjectIndex({
			fs,
			agentDir: "/agent",
			record: {
				schemaVersion: SCHEMA_VERSION,
				worktreePath: customWorktreePath,
				projectRoot: projectPaths.projectRoot,
				projectId: projectPaths.projectId,
				planId: "plan-a",
			},
		});
		await seedPlannerSkillIndex(fs, projectPaths, [
			{ name: "pi-planner-proj-44444444", updatedAt: 1000 },
		]);

		// Resume runs discovery with the worktree as cwd; it must resolve back to
		// the owning project's skills and still serve the system elenchus first.
		const resolved = await listPlannerSkillResourcePaths({
			fs,
			agentDir: "/agent",
			cwd: customWorktreePath,
			plannerActive: true,
		});

		expect(resolved[0]).toBe(
			"/agent/extensions/pi-code-planner/system-skills/elenchus/SKILL.md",
		);
		expect(resolved).toContain(
			`${createPlannerSkillStoragePaths(projectPaths).libraryDir}/pi-planner-proj-44444444/SKILL.md`,
		);
	});

	it("does not expose planner skills to non-planner sessions", async () => {
		const { fs, git, projectPaths } = await createSkillSetup();
		const created = await executePlannerSkillTool({
			fs,
			git,
			projectPaths,
			uuid: "11111111-1234-1234-1234-123456789abc",
			now: 1000,
			params: {
				nameHint: "Planner only",
				description:
					"ACTIVATE only inside planner sessions when a reusable planner lesson is relevant.",
				bodyMarkdown: "# Planner Only\n\nDo not load outside planner sessions.",
				sourceKind: "other",
			},
		});

		expect(created.status).toBe("applied");
		await expect(
			listPlannerSkillResourcePaths({
				fs,
				agentDir: "/agent",
				cwd: projectPaths.projectRoot,
				plannerActive: false,
			}),
		).resolves.toEqual([]);
	});

	it("respects skills.enabled and skills.maxActive when exposing resources", async () => {
		const { fs, projectPaths } = await createSkillSetup();
		await seedPlannerSkillIndex(fs, projectPaths, [
			{ name: "pi-planner-old-11111111", updatedAt: 1000 },
			{ name: "pi-planner-new-22222222", updatedAt: 3000 },
			{ name: "pi-planner-mid-33333333", updatedAt: 2000 },
		]);
		await fs.writeTextAtomic(
			"/repo/app/.pi/pi-code-planner/settings.json",
			'{ "skills": { "maxActive": 2 } }\n',
		);

		await expect(
			listPlannerSkillResourcePaths({
				fs,
				agentDir: "/agent",
				cwd: projectPaths.projectRoot,
				plannerActive: true,
			}),
		).resolves.toEqual([
			"/agent/extensions/pi-code-planner/system-skills/elenchus/SKILL.md",
			`${createPlannerSkillStoragePaths(projectPaths).libraryDir}/pi-planner-new-22222222/SKILL.md`,
			`${createPlannerSkillStoragePaths(projectPaths).libraryDir}/pi-planner-mid-33333333/SKILL.md`,
		]);

		await fs.writeTextAtomic(
			"/repo/app/.pi/pi-code-planner/settings.json",
			'{ "skills": { "enabled": false } }\n',
		);
		await expect(
			listPlannerSkillResourcePaths({
				fs,
				agentDir: "/agent",
				cwd: projectPaths.projectRoot,
				plannerActive: true,
			}),
		).resolves.toEqual([]);
	});

	it("lists active planner skill summaries for status inventory", async () => {
		const { fs, projectPaths } = await createSkillSetup();
		await seedPlannerSkillIndex(fs, projectPaths, [
			{ name: "pi-planner-old-11111111", updatedAt: 1000 },
			{ name: "pi-planner-new-22222222", updatedAt: 3000 },
			{ name: "pi-planner-mid-33333333", updatedAt: 2000 },
		]);
		await fs.writeTextAtomic(
			"/repo/app/.pi/pi-code-planner/settings.json",
			'{ "skills": { "maxActive": 2 } }\n',
		);

		await expect(
			listActivePlannerSkillSummaries({ fs, projectPaths }),
		).resolves.toMatchObject([
			{
				name: "pi-planner-new-22222222",
				sourceKind: "other",
				description: "Use when testing planner skill resource selection.",
			},
			{
				name: "pi-planner-mid-33333333",
				sourceKind: "other",
				description: "Use when testing planner skill resource selection.",
			},
		]);
	});

	it("lists the full planner skill inventory regardless active exposure settings", async () => {
		const { fs, projectPaths } = await createSkillSetup();
		await seedPlannerSkillIndex(fs, projectPaths, [
			{ name: "pi-planner-old-11111111", updatedAt: 1000 },
			{ name: "pi-planner-new-22222222", updatedAt: 3000 },
			{ name: "pi-planner-mid-33333333", updatedAt: 2000 },
		]);
		await fs.writeTextAtomic(
			"/repo/app/.pi/pi-code-planner/settings.json",
			'{ "skills": { "enabled": false, "maxActive": 1 } }\n',
		);

		await expect(
			listActivePlannerSkillSummaries({ fs, projectPaths }),
		).resolves.toEqual([]);
		await expect(
			listPlannerSkillInventory({ fs, projectPaths }),
		).resolves.toMatchObject([
			{ name: "pi-planner-new-22222222" },
			{ name: "pi-planner-mid-33333333" },
			{ name: "pi-planner-old-11111111" },
		]);
	});

	it("ignores indexed planner skills whose SKILL.md file is missing", async () => {
		const { fs, projectPaths } = await createSkillSetup();
		await seedPlannerSkillIndex(fs, projectPaths, [
			{ name: "pi-planner-missing-11111111", updatedAt: 1000 },
			{ name: "pi-planner-existing-22222222", updatedAt: 2000 },
		]);
		await fs.removeFile(
			`${createPlannerSkillStoragePaths(projectPaths).libraryDir}/pi-planner-missing-11111111/SKILL.md`,
		);

		await expect(
			listPlannerSkillInventory({ fs, projectPaths }),
		).resolves.toMatchObject([{ name: "pi-planner-existing-22222222" }]);
	});

	it("deletes a planner skill from the library and index", async () => {
		const { fs, projectPaths } = await createSkillSetup();
		await seedPlannerSkillIndex(fs, projectPaths, [
			{ name: "pi-planner-delete-me-11111111", updatedAt: 1000 },
			{ name: "pi-planner-keep-me-22222222", updatedAt: 2000 },
		]);

		const deleted = await deletePlannerSkill({
			fs,
			projectPaths,
			name: "pi-planner-delete-me-11111111",
		});

		expect(deleted).toMatchObject({
			name: "pi-planner-delete-me-11111111",
		});
		await expect(
			listActivePlannerSkillSummaries({ fs, projectPaths }),
		).resolves.toMatchObject([{ name: "pi-planner-keep-me-22222222" }]);
		expect(
			await fs.exists(
				`${createPlannerSkillStoragePaths(projectPaths).libraryDir}/pi-planner-delete-me-11111111/SKILL.md`,
			),
		).toBe(false);
	});

	it("refuses to delete skill paths outside the planner skill library", async () => {
		const { fs, projectPaths } = await createSkillSetup();
		const paths = createPlannerSkillStoragePaths(projectPaths);
		await fs.writeTextAtomic(
			"/tmp/not-a-planner-skill/SKILL.md",
			"# Outside\n",
		);
		await fs.writeTextAtomic(
			paths.indexJson,
			`${JSON.stringify(
				{
					version: 1,
					items: [
						{
							id: "pi-planner-outside-11111111",
							name: "pi-planner-outside-11111111",
							description: "Use when testing guarded deletion.",
							status: "active",
							tags: [],
							sourceKind: "other",
							sourcePlanId: null,
							sourceTaskId: null,
							language: "English",
							skillPath: "/tmp/not-a-planner-skill/SKILL.md",
							createdAt: 1000,
							updatedAt: 1000,
							hash: "outside",
						},
					],
				},
				null,
				2,
			)}\n`,
		);

		await expect(
			deletePlannerSkill({
				fs,
				projectPaths,
				name: "pi-planner-outside-11111111",
			}),
		).rejects.toThrow("outside library");
		await expect(fs.exists("/tmp/not-a-planner-skill/SKILL.md")).resolves.toBe(
			true,
		);
	});

	it("blocks skill creation when the planner state does not allow the wrapper", async () => {
		const fs = new MockPlannerFs();
		const git = new MockGitRunner();
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});

		const result = await executePlannerSkillTool({
			fs,
			git,
			projectPaths,
			params: {
				nameHint: "blocked",
				description: "ACTIVATE when this should not be created.",
				bodyMarkdown: "# Blocked",
				sourceKind: "other",
			},
		});

		expect(result.status).toBe("blocked");
		expect(result.text).toContain("Project record does not exist");
	});

	it("keeps each project's skill pool isolated", async () => {
		const fs = new MockPlannerFs();
		const projectA = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app-a",
		});
		const projectB = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app-b",
		});
		await seedPlannerSkillIndex(fs, projectA, [
			{ name: "pi-planner-only-a-11111111", updatedAt: 1000 },
		]);

		await expect(
			listPlannerSkillInventory({ fs, projectPaths: projectA }),
		).resolves.toMatchObject([{ name: "pi-planner-only-a-11111111" }]);
		// Project B has its own (empty) pool and cannot see project A's skill.
		await expect(
			listPlannerSkillInventory({ fs, projectPaths: projectB }),
		).resolves.toEqual([]);
		expect(createPlannerSkillStoragePaths(projectA).libraryDir).not.toBe(
			createPlannerSkillStoragePaths(projectB).libraryDir,
		);
	});

	it("still surfaces pre-per-project global skills as a read-only fallback", async () => {
		const { fs, projectPaths } = await createSkillSetup();
		// A skill from the old global pool at extensionDir/skills (no projectId).
		const legacyPath =
			"/agent/extensions/pi-code-planner/skills/library/pi-planner-legacy-99999999/SKILL.md";
		await fs.writeTextAtomic(
			legacyPath,
			"---\nname: pi-planner-legacy-99999999\ndescription: legacy.\n---\n\n# Legacy\n",
		);
		await fs.writeTextAtomic(
			"/agent/extensions/pi-code-planner/skills/index.json",
			`${JSON.stringify(
				{
					version: 1,
					items: [
						{
							id: "pi-planner-legacy-99999999",
							name: "pi-planner-legacy-99999999",
							description: "legacy.",
							status: "active",
							tags: [],
							sourceKind: "other",
							sourcePlanId: null,
							sourceTaskId: null,
							language: "English",
							skillPath: legacyPath,
							createdAt: 1,
							updatedAt: 1,
							hash: "legacy",
						},
					],
				},
				null,
				2,
			)}\n`,
		);

		await expect(
			listPlannerSkillResourcePaths({
				fs,
				agentDir: "/agent",
				cwd: projectPaths.projectRoot,
				plannerActive: true,
			}),
		).resolves.toContain(legacyPath);
	});

	it("validates Pi-compatible folded and single-line skill frontmatter", () => {
		expect(
			validatePlannerSkillMarkdown(
				[
					"---",
					"name: pi-planner-example-12345678",
					"description: >",
					"  ACTIVATE when a planner task hits a known Pi extension session switch issue.",
					"  Use the fresh replacement ctx for follow-up messages.",
					"---",
					"",
					"# Example",
				].join("\n"),
			),
		).toMatchObject({
			valid: true,
			name: "pi-planner-example-12345678",
		});

		expect(
			validatePlannerSkillMarkdown(
				[
					"---",
					"name: pi-planner-example-12345678",
					"description: Use when a planner task hits a known Pi extension issue.",
					"---",
					"",
					"# Example",
				].join("\n"),
			),
		).toMatchObject({ valid: true });
	});

	it("rejects malformed multiline description indentation", () => {
		const result = validatePlannerSkillMarkdown(
			[
				"---",
				"name: pi-planner-example-12345678",
				"description: >",
				" ACTIVATE when indentation is wrong.",
				"---",
				"",
				"# Example",
			].join("\n"),
		);

		expect(result).toMatchObject({
			valid: false,
			reason: expect.stringContaining("indented with two spaces"),
		});
	});
});

async function createSkillSetup(input?: { worktreePath?: string }) {
	const fs = new MockPlannerFs();
	const git = new MockGitRunner();
	const projectPaths = createProjectStoragePaths({
		agentDir: "/agent",
		projectRoot: "/repo/app",
	});
	const planPaths = createPlanStoragePaths(projectPaths, "plan-a");
	const worktreePath =
		input?.worktreePath ?? "/repo/app/.pi/pi-code-planner/worktrees/plan-a";
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
		stage: "finalize",
		step: "doubt_review",
		stepStatus: "running",
		currentBranch: "plan/plan-a",
	});
	await setActivePlan(fs, projectPaths, "plan-a");
	return { fs, git, projectPaths, planPaths };
}

async function seedPlannerSkillIndex(
	fs: MockPlannerFs,
	projectPaths: ReturnType<typeof createProjectStoragePaths>,
	items: Array<{ name: string; updatedAt: number }>,
): Promise<void> {
	const paths = createPlannerSkillStoragePaths(projectPaths);
	const indexItems = [];
	for (const item of items) {
		const skillPath = `${paths.libraryDir}/${item.name}/SKILL.md`;
		await fs.writeTextAtomic(
			skillPath,
			[
				"---",
				`name: ${item.name}`,
				"description: Use when testing planner skill resource selection.",
				"---",
				"",
				`# ${item.name}`,
				"",
			].join("\n"),
		);
		indexItems.push({
			id: item.name,
			name: item.name,
			description: "Use when testing planner skill resource selection.",
			status: "active",
			tags: [],
			sourceKind: "other",
			sourcePlanId: null,
			sourceTaskId: null,
			language: "English",
			skillPath,
			createdAt: item.updatedAt,
			updatedAt: item.updatedAt,
			hash: item.name,
		});
	}
	await fs.writeTextAtomic(
		paths.indexJson,
		`${JSON.stringify({ version: 1, items: indexItems }, null, 2)}\n`,
	);
}
