import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import register from "./index";

const mockedAgent = vi.hoisted(() => ({
	dir: "",
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return {
		...actual,
		getAgentDir: () => mockedAgent.dir,
	};
});

interface RegisteredExtension {
	tools: ToolDefinition[];
	handlers: Map<
		string,
		Array<(event: unknown, ctx: ExtensionContext) => unknown>
	>;
	pi: ExtensionAPI;
}

function createRegisteredExtension(): RegisteredExtension {
	const tools: ToolDefinition[] = [];
	const handlers = new Map<
		string,
		Array<(event: unknown, ctx: ExtensionContext) => unknown>
	>();
	const pi = {
		registerTool: vi.fn((tool: ToolDefinition) => {
			tools.push(tool);
		}),
		on: vi.fn(
			(
				event: string,
				handler: (event: unknown, ctx: ExtensionContext) => unknown,
			) => {
				const current = handlers.get(event) ?? [];
				current.push(handler);
				handlers.set(event, current);
			},
		),
		sendUserMessage: vi.fn(),
	} as unknown as ExtensionAPI;

	register(pi);
	return { tools, handlers, pi };
}

function toolByName(tools: ToolDefinition[], name: string): ToolDefinition {
	const tool = tools.find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`Missing tool: ${name}`);
	return tool;
}

function context(cwd: string): ExtensionContext {
	return {
		cwd,
		compact: vi.fn(),
		isIdle: vi.fn(() => true),
		hasPendingMessages: vi.fn(() => false),
		ui: {
			setStatus: vi.fn(),
		},
	} as unknown as ExtensionContext;
}

function hasGit(): boolean {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function createCleanGitProject(root: string): string {
	const project = join(root, "project");
	execFileSync("git", ["init", project], { stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "pi-planner@example.test"], {
		cwd: project,
	});
	execFileSync("git", ["config", "user.name", "Pi Planner Test"], {
		cwd: project,
	});
	writeFileSync(join(project, "README.md"), "initial\n", "utf-8");
	execFileSync("git", ["add", "--all"], { cwd: project });
	execFileSync("git", ["commit", "-m", "initial commit"], {
		cwd: project,
		stdio: "ignore",
	});
	return project;
}

describe("extension entrypoint", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-planner-index-"));
		mockedAgent.dir = join(tempRoot, "agent");
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it("registers git, compaction, and workflow tools", () => {
		const { tools } = createRegisteredExtension();

		expect(tools.map((tool) => tool.name)).toEqual(
			expect.arrayContaining([
				"planner_initialize_repo",
				"planner_request_compact",
				"planner_create_plan",
				"planner_transition_work_item",
				"planner_runtime_status",
				"planner_next_step",
				"planner_memory_status",
			]),
		);
	});

	it("sets a focused planner status on session start", async () => {
		const { handlers } = createRegisteredExtension();
		const ctx = context(join(tempRoot, "project"));

		const [sessionStart] = handlers.get("session_start") ?? [];
		await sessionStart({}, ctx);

		expect(ctx.ui.setStatus).toHaveBeenCalledWith("pi-planner", "planner idle");
		expect(vi.mocked(ctx.ui.setStatus).mock.calls[0][1]).not.toContain("3r");
	});

	it("connects workflow tools to the real orchestrator and prompt assembly", async () => {
		const { tools } = createRegisteredExtension();
		const ctx = context(join(tempRoot, "project"));
		const createPlan = toolByName(tools, "planner_create_plan");

		const result = await createPlan.execute(
			"call-1",
			{ title: "Parser plan", planId: "plan-1" },
			undefined,
			undefined,
			ctx,
		);

		expect(result.content[0].text).toContain("Planner plan created.");
		expect(result.content[0].text).toContain("NEXT PLANNER INSTRUCTION");
		expect(result.content[0].text).toContain("- planId: plan-1");
		expect(result.details).toMatchObject({
			result: {
				planId: "plan-1",
				stage: "plan_draft",
			},
			nextPrompt: {
				artifactPaths: expect.arrayContaining([
					expect.stringContaining("/plans/plan-1/plan.md"),
				]),
			},
		});
	});

	it("refreshes planner status after planner tool execution", async () => {
		const { tools } = createRegisteredExtension();
		const ctx = context(join(tempRoot, "project"));
		const createPlan = toolByName(tools, "planner_create_plan");

		await createPlan.execute(
			"call-1",
			{ title: "Parser plan", planId: "plan-1" },
			undefined,
			undefined,
			ctx,
		);

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
			"pi-planner",
			"planner blocked:init_required",
		);
	});

	it("keeps work item creation in plan context", async () => {
		const { tools } = createRegisteredExtension();
		const ctx = context(join(tempRoot, "project"));
		const createPlan = toolByName(tools, "planner_create_plan");
		const createWorkItem = toolByName(tools, "planner_create_work_item");

		await createPlan.execute(
			"call-1",
			{ title: "Parser plan", planId: "plan-1" },
			undefined,
			undefined,
			ctx,
		);
		const result = await createWorkItem.execute(
			"call-2",
			{
				planId: "plan-1",
				title: "Parser API",
				workItemId: "parser-api",
			},
			undefined,
			undefined,
			ctx,
		);

		expect(result.content[0].text).toContain("Planner work item created.");
		expect(result.content[0].text).toContain("- scope: plan");
		expect(result.content[0].text).not.toContain("- scope: work_item");
		expect(result.details).toMatchObject({
			result: {
				workItemId: "parser-api",
				stage: "pending",
			},
			nextPrompt: {
				artifactPaths: expect.arrayContaining([
					expect.stringContaining("/plans/plan-1/plan.md"),
				]),
			},
		});
	});

	it("connects runtime status to active planner recovery checks", async () => {
		const { tools } = createRegisteredExtension();
		const ctx = context(join(tempRoot, "project"));
		const createPlan = toolByName(tools, "planner_create_plan");
		const runtimeStatus = toolByName(tools, "planner_runtime_status");

		await createPlan.execute(
			"call-1",
			{ title: "Parser plan", planId: "plan-1" },
			undefined,
			undefined,
			ctx,
		);
		const result = await runtimeStatus.execute(
			"call-2",
			{},
			undefined,
			undefined,
			ctx,
		);

		expect(result.content[0].text).toBe("Git repository is missing.");
		expect(result.details).toMatchObject({
			status: "recovery_required",
			recovery: {
				status: "init_required",
			},
		});
	});

	it("connects planner next step to the real cycle manager", async () => {
		const { tools } = createRegisteredExtension();
		const ctx = context(join(tempRoot, "project"));
		const createPlan = toolByName(tools, "planner_create_plan");
		const nextStep = toolByName(tools, "planner_next_step");

		await createPlan.execute(
			"call-1",
			{ title: "Parser plan", planId: "plan-1" },
			undefined,
			undefined,
			ctx,
		);
		const result = await nextStep.execute(
			"call-2",
			{},
			undefined,
			undefined,
			ctx,
		);

		expect(result.content[0].text).toBe("Git repository is missing.");
		expect(result.details).toMatchObject({
			status: "blocked",
			kind: "recovery",
			requiredTool: "planner_runtime_status",
		});
	});

	it("attaches completed compact resume on before_agent_start", async () => {
		const { handlers, tools } = createRegisteredExtension();
		const ctx = context(join(tempRoot, "project"));
		const compact = vi.mocked(ctx.compact);
		const compactTool = toolByName(tools, "planner_request_compact");

		await compactTool.execute(
			"call-1",
			{
				reason: "discovery",
				customInstructions: "compact now",
				resumePrompt: "resume from planner memory",
			},
			undefined,
			undefined,
			ctx,
		);
		const compactOptions = compact.mock.calls[0][0];
		compactOptions.onComplete?.();

		const [beforeAgentStart] = handlers.get("before_agent_start") ?? [];
		const result = await beforeAgentStart({ systemPrompt: "base prompt" }, ctx);

		expect(result).toEqual({
			systemPrompt: "base prompt\n\nresume from planner memory",
		});
	});

	it.runIf(hasGit())(
		"connects plan stages, next step, discovery compact, resume, and completion",
		async () => {
			const { handlers, tools } = createRegisteredExtension();
			const project = createCleanGitProject(tempRoot);
			const ctx = context(project);
			const createPlan = toolByName(tools, "planner_create_plan");
			const startPlan = toolByName(tools, "planner_start_plan");
			const transitionPlan = toolByName(tools, "planner_transition_plan");
			const nextStep = toolByName(tools, "planner_next_step");
			const requestCompact = toolByName(
				tools,
				"planner_request_discovery_compact",
			);
			const completeCompact = toolByName(
				tools,
				"planner_complete_discovery_compact",
			);

			await createPlan.execute(
				"call-1",
				{ title: "Parser plan", planId: "plan-1" },
				undefined,
				undefined,
				ctx,
			);
			await startPlan.execute(
				"call-2",
				{ planId: "plan-1" },
				undefined,
				undefined,
				ctx,
			);
			await transitionPlan.execute(
				"call-3",
				{ planId: "plan-1", stage: "discovery_full" },
				undefined,
				undefined,
				ctx,
			);
			await transitionPlan.execute(
				"call-4",
				{ planId: "plan-1", stage: "discovery_compact_required" },
				undefined,
				undefined,
				ctx,
			);

			const compactStep = await nextStep.execute(
				"call-5",
				{},
				undefined,
				undefined,
				ctx,
			);
			expect(compactStep.details).toMatchObject({
				status: "blocked",
				kind: "compact_required",
				requiredTool: "planner_request_discovery_compact",
				instructionName: "compact",
				sectionName: "discovery_compact_required",
			});

			const compactResult = await requestCompact.execute(
				"call-6",
				{
					planId: "plan-1",
					customInstructions: "compact discovery",
					resumePrompt: "resume discovery",
				},
				undefined,
				undefined,
				ctx,
			);
			expect(compactResult.details).toMatchObject({
				result: {
					kind: "started",
					pending: {
						reason: "discovery",
						activePlanId: "plan-1",
					},
				},
			});

			const compactOptions = vi.mocked(ctx.compact).mock.calls[0][0];
			compactOptions.onComplete?.();
			const [beforeAgentStart] = handlers.get("before_agent_start") ?? [];
			const resume = await beforeAgentStart(
				{ systemPrompt: "base prompt" },
				ctx,
			);
			expect(resume).toEqual({
				systemPrompt: "base prompt\n\nresume discovery",
			});

			const completeResult = await completeCompact.execute(
				"call-7",
				{ planId: "plan-1" },
				undefined,
				undefined,
				ctx,
			);
			expect(completeResult.details).toMatchObject({
				result: {
					current: {
						stage: "post_discovery_questions",
					},
				},
			});

			const afterCompactStep = await nextStep.execute(
				"call-8",
				{},
				undefined,
				undefined,
				ctx,
			);
			expect(afterCompactStep.details).toMatchObject({
				status: "ready",
				kind: "plan_stage",
				instructionName: "plan",
				sectionName: "post_discovery_questions",
			});
		},
	);

	it.runIf(hasGit())(
		"connects work item branch, commit, signature refresh, compact, and completion",
		async () => {
			const { handlers, tools } = createRegisteredExtension();
			const project = createCleanGitProject(tempRoot);
			const ctx = context(project);
			const createPlan = toolByName(tools, "planner_create_plan");
			const startPlan = toolByName(tools, "planner_start_plan");
			const transitionPlan = toolByName(tools, "planner_transition_plan");
			const createWorkItem = toolByName(tools, "planner_create_work_item");
			const transitionWorkItem = toolByName(
				tools,
				"planner_transition_work_item",
			);
			const startWorkItem = toolByName(tools, "planner_start_work_item");
			const finishWorkItem = toolByName(tools, "planner_finish_work_item");
			const upsertFiles = toolByName(tools, "planner_memory_upsert_files");
			const clearDirty = toolByName(tools, "planner_memory_clear_dirty");
			const nextStep = toolByName(tools, "planner_next_step");
			const requestCompact = toolByName(
				tools,
				"planner_request_work_item_compact",
			);
			const completeCompact = toolByName(
				tools,
				"planner_complete_work_item_compact",
			);

			await createPlan.execute(
				"call-1",
				{ title: "Parser plan", planId: "plan-1" },
				undefined,
				undefined,
				ctx,
			);
			await startPlan.execute(
				"call-2",
				{ planId: "plan-1" },
				undefined,
				undefined,
				ctx,
			);
			await transitionPlan.execute(
				"call-3",
				{ planId: "plan-1", stage: "plan_active" },
				undefined,
				undefined,
				ctx,
			);
			await createWorkItem.execute(
				"call-4",
				{
					planId: "plan-1",
					title: "Feature file",
					workItemId: "feature-file",
				},
				undefined,
				undefined,
				ctx,
			);
			await startWorkItem.execute(
				"call-5",
				{ workItemId: "feature-file" },
				undefined,
				undefined,
				ctx,
			);

			for (const stage of [
				"ready",
				"active",
				"tdd_prepare",
				"tdd_write_tests",
				"tdd_tests_commit",
				"experiments_running",
				"candidate_selection",
				"candidate_merged",
				"verification",
				"work_item_commit",
			] as const) {
				await transitionWorkItem.execute(
					`stage-${stage}`,
					{
						planId: "plan-1",
						workItemId: "feature-file",
						stage,
					},
					undefined,
					undefined,
					ctx,
				);
			}

			writeFileSync(join(project, "feature.txt"), "feature\n", "utf-8");
			const commitResult = await finishWorkItem.execute(
				"call-6",
				{ message: "feat: add feature file", stageAll: true },
				undefined,
				undefined,
				ctx,
			);
			expect(commitResult.content[0].text).toBe("Planner work item committed.");

			const refreshStep = await nextStep.execute(
				"call-7",
				{},
				undefined,
				undefined,
				ctx,
			);
			expect(refreshStep.details).toMatchObject({
				status: "blocked",
				kind: "memory_refresh",
				requiredTool: "planner_memory_get_dirty",
				dirtyFiles: ["feature.txt"],
			});

			await transitionWorkItem.execute(
				"call-8",
				{
					planId: "plan-1",
					workItemId: "feature-file",
					stage: "signature_refresh",
				},
				undefined,
				undefined,
				ctx,
			);
			await upsertFiles.execute(
				"call-9",
				{
					entries: [
						{
							filePath: "feature.txt",
							kind: "source",
							language: "text",
							hash: null,
							sizeBytes: null,
							indexedAt: "2026-05-16T00:00:00.000Z",
							indexStatus: "indexed",
							summary: "Feature file added by the work item.",
						},
					],
				},
				undefined,
				undefined,
				ctx,
			);
			await clearDirty.execute(
				"call-10",
				{ filePaths: ["feature.txt"] },
				undefined,
				undefined,
				ctx,
			);
			await transitionWorkItem.execute(
				"call-11",
				{
					planId: "plan-1",
					workItemId: "feature-file",
					stage: "work_item_compact_required",
				},
				undefined,
				undefined,
				ctx,
			);

			const compactStep = await nextStep.execute(
				"call-12",
				{},
				undefined,
				undefined,
				ctx,
			);
			expect(compactStep.details).toMatchObject({
				status: "blocked",
				kind: "compact_required",
				requiredTool: "planner_request_work_item_compact",
				instructionName: "compact",
				sectionName: "work_item_compact_required",
			});

			await requestCompact.execute(
				"call-13",
				{
					planId: "plan-1",
					workItemId: "feature-file",
					customInstructions: "compact work item",
					resumePrompt: "resume work item",
				},
				undefined,
				undefined,
				ctx,
			);
			const compactOptions = vi.mocked(ctx.compact).mock.calls[0][0];
			compactOptions.onComplete?.();
			const [beforeAgentStart] = handlers.get("before_agent_start") ?? [];
			const resume = await beforeAgentStart(
				{ systemPrompt: "base prompt" },
				ctx,
			);
			expect(resume).toEqual({
				systemPrompt: "base prompt\n\nresume work item",
			});

			const completeResult = await completeCompact.execute(
				"call-14",
				{ planId: "plan-1", workItemId: "feature-file" },
				undefined,
				undefined,
				ctx,
			);
			expect(completeResult.details).toMatchObject({
				result: {
					current: {
						stage: "completed",
					},
				},
			});
		},
	);
});
