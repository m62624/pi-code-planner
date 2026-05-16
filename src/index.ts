import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { CompactionCoordinator } from "./compaction/coordinator";
import { EXTENSION_NAME } from "./constants";
import { PlannerCycleManager } from "./cycle/manager";
import { createGitCore, type GitCore } from "./git/core";
import {
	checkPlannerToolCall,
	checkPlannerUserBash,
} from "./git/tool-call-events";
import { createMemoryCore, type MemoryCore } from "./memory/core";
import { syncDirtyMemoryFromRepo } from "./memory/dirty-sync";
import {
	createPlannerOrchestrator,
	type PlannerOrchestrator,
} from "./orchestrator/planner-orchestrator";
import { PlannerRuntimeController } from "./runtime/planner-runtime-controller";
import { checkPlannerStageToolCall } from "./runtime/stage-tool-guard";
import { createPlannerCompactionTools } from "./tools/planner-compaction-tools";
import { createPlannerCycleTools } from "./tools/planner-cycle-tools";
import { createPlannerGitTools } from "./tools/planner-git-tools";
import { createPlannerMemoryTools } from "./tools/planner-memory-tools";
import { createPlannerRuntimeTools } from "./tools/planner-runtime-tools";
import { createPlannerWorkflowTools } from "./tools/planner-workflow-tools";

export default function register(pi: ExtensionAPI): void {
	const cores = new Map<string, GitCore>();
	const compactors = new Map<string, CompactionCoordinator>();
	const orchestrators = new Map<string, PlannerOrchestrator>();
	const runtimeControllers = new Map<string, PlannerRuntimeController>();
	const cycleManagers = new Map<string, PlannerCycleManager>();
	const memoryCores = new Map<string, MemoryCore>();

	function getCore(cwd: string): GitCore {
		const cached = cores.get(cwd);
		if (cached) return cached;

		const core = createGitCore({
			agentDir: getAgentDir(),
			cwd,
			extensionName: EXTENSION_NAME,
		});
		cores.set(cwd, core);
		return core;
	}

	function getCompactor(cwd: string): CompactionCoordinator {
		const cached = compactors.get(cwd);
		if (cached) return cached;

		const compactor = new CompactionCoordinator({
			state: getCore(cwd).state,
		});
		compactors.set(cwd, compactor);
		return compactor;
	}

	function getOrchestrator(cwd: string): PlannerOrchestrator {
		const cached = orchestrators.get(cwd);
		if (cached) return cached;

		const orchestrator = createPlannerOrchestrator(
			getCore(cwd),
			cwd,
			getCompactor(cwd),
		);
		orchestrators.set(cwd, orchestrator);
		return orchestrator;
	}

	function getRuntimeController(cwd: string): PlannerRuntimeController {
		const cached = runtimeControllers.get(cwd);
		if (cached) return cached;

		const controller = new PlannerRuntimeController(
			getCore(cwd),
			getOrchestrator(cwd),
			getMemoryCore(cwd),
			getCore(cwd).settings.settings.memory,
		);
		runtimeControllers.set(cwd, controller);
		return controller;
	}

	function getCycleManager(cwd: string): PlannerCycleManager {
		const cached = cycleManagers.get(cwd);
		if (cached) return cached;

		const manager = new PlannerCycleManager({
			runtime: getRuntimeController(cwd),
		});
		cycleManagers.set(cwd, manager);
		return manager;
	}

	function getMemoryCore(cwd: string): MemoryCore {
		const cached = memoryCores.get(cwd);
		if (cached) return cached;

		const core = getCore(cwd);
		const memory = createMemoryCore({
			paths: core.paths,
			fs: core.fs,
			projectPath: cwd,
		});
		memoryCores.set(cwd, memory);
		return memory;
	}

	const getDirtyMemory = async (cwd: string) => {
		const core = getCore(cwd);
		const memory = getMemoryCore(cwd);
		const repo = await core.readRepoState();
		return syncDirtyMemoryFromRepo({
			plannerState: core.state.get(),
			memory: memory.store,
			repo,
			settings: core.settings.settings.memory,
		}).dirty;
	};
	const getMemoryDirtyPolicy = (cwd: string) =>
		getCore(cwd).settings.settings.memory.dirtyPolicy;

	for (const tool of createPlannerGitTools(
		getCore,
		getDirtyMemory,
		getMemoryDirtyPolicy,
	)) {
		pi.registerTool(tool);
	}
	for (const tool of createPlannerCompactionTools(
		getCompactor,
		getDirtyMemory,
		getMemoryDirtyPolicy,
	)) {
		pi.registerTool(tool);
	}
	for (const tool of createPlannerWorkflowTools(
		getOrchestrator,
		getDirtyMemory,
		getMemoryDirtyPolicy,
	)) {
		pi.registerTool(tool);
	}
	for (const tool of createPlannerRuntimeTools(getRuntimeController)) {
		pi.registerTool(tool);
	}
	for (const tool of createPlannerCycleTools(getCycleManager)) {
		pi.registerTool(tool);
	}
	for (const tool of createPlannerMemoryTools(
		(cwd) => getMemoryCore(cwd).store,
	)) {
		pi.registerTool(tool);
	}

	pi.on("session_start", async (_event, ctx) => {
		const core = getCore(ctx.cwd);
		const preflight = await core.preflight.check("start_plan");

		ctx.ui.setStatus(
			EXTENSION_NAME,
			`planner ${core.settings.settings.refactor.maxIterations}r ${preflight.recovery.status}`,
		);
	});

	pi.on("tool_call", async (event, ctx) => {
		const core = getCore(ctx.cwd);
		const gitGuard = checkPlannerToolCall(core, event);
		if (gitGuard) return gitGuard;

		const inspection = await getRuntimeController(ctx.cwd).inspect();
		return checkPlannerStageToolCall({
			inspection,
			toolName: event.toolName,
			input: event.input as Record<string, unknown>,
			artifactsRoot: core.paths.globalDir,
		});
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const resume = getCompactor(ctx.cwd).consumeResumeInstructionForNextTurn();
		if (!resume) return;

		return {
			systemPrompt: `${event.systemPrompt}\n\n${resume}`,
		};
	});

	pi.on("session_compact", async (_event, ctx) => {
		setTimeout(() => {
			getCompactor(ctx.cwd).sendAutoResumeIfIdle({
				ctx,
				messenger: pi,
			});
		}, 250);
	});

	pi.on("user_bash", async (event) => {
		return checkPlannerUserBash(getCore(event.cwd), event);
	});
}
