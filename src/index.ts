import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
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
import type { PlannerRuntimeInspection } from "./runtime/planner-runtime-controller";
import { PlannerRuntimeController } from "./runtime/planner-runtime-controller";
import { checkPlannerStageToolCall } from "./runtime/stage-tool-guard";
import { createPlannerCompactionTools } from "./tools/planner-compaction-tools";
import { createPlannerCycleTools } from "./tools/planner-cycle-tools";
import { createPlannerGitTools } from "./tools/planner-git-tools";
import { createPlannerMemoryTools } from "./tools/planner-memory-tools";
import { createPlannerRuntimeTools } from "./tools/planner-runtime-tools";
import { createPlannerWorkflowTools } from "./tools/planner-workflow-tools";

function formatPlannerStatus(inspection: PlannerRuntimeInspection): string {
	if (inspection.status === "idle") return "idle";
	if (inspection.status === "recovery_required") {
		return `blocked:${inspection.recovery.status}`;
	}
	if (inspection.status === "memory_refresh_required") {
		return `memory:${Object.keys(inspection.memory.dirty.files).length}`;
	}
	if (inspection.status === "compact_pending") return "compact:pending";
	if (inspection.status === "compact_required") {
		return `compact:${inspection.decision.compactReason ?? "required"}`;
	}
	if (inspection.workItem) return `item:${inspection.workItem.stage}`;
	if (inspection.plan) return `plan:${inspection.plan.stage}`;
	return inspection.status;
}

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

	async function updatePlannerStatus(ctx: ExtensionContext): Promise<void> {
		const inspection = await getRuntimeController(ctx.cwd).inspect();
		ctx.ui.setStatus(
			EXTENSION_NAME,
			`planner ${formatPlannerStatus(inspection)}`,
		);
	}

	function registerPlannerTool(tool: ToolDefinition): void {
		pi.registerTool({
			...tool,
			execute: async (toolCallId, params, signal, onUpdate, ctx) => {
				try {
					return await tool.execute(toolCallId, params, signal, onUpdate, ctx);
				} finally {
					await updatePlannerStatus(ctx);
				}
			},
		});
	}

	for (const tool of createPlannerGitTools(
		getCore,
		getDirtyMemory,
		getMemoryDirtyPolicy,
	)) {
		registerPlannerTool(tool);
	}
	for (const tool of createPlannerCompactionTools(
		getCompactor,
		getDirtyMemory,
		getMemoryDirtyPolicy,
	)) {
		registerPlannerTool(tool);
	}
	for (const tool of createPlannerWorkflowTools(
		getOrchestrator,
		getDirtyMemory,
		getMemoryDirtyPolicy,
	)) {
		registerPlannerTool(tool);
	}
	for (const tool of createPlannerRuntimeTools(getRuntimeController)) {
		registerPlannerTool(tool);
	}
	for (const tool of createPlannerCycleTools(getCycleManager)) {
		registerPlannerTool(tool);
	}
	for (const tool of createPlannerMemoryTools(
		(cwd) => getMemoryCore(cwd).store,
	)) {
		registerPlannerTool(tool);
	}

	pi.on("session_start", async (_event, ctx) => {
		await updatePlannerStatus(ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		const core = getCore(ctx.cwd);
		const gitGuard = checkPlannerToolCall(core, event);
		if (gitGuard) return gitGuard;

		const inspection = await getRuntimeController(ctx.cwd).inspect();
		const stageGuard = checkPlannerStageToolCall({
			inspection,
			toolName: event.toolName,
			input: event.input as Record<string, unknown>,
			artifactsRoot: core.paths.globalDir,
		});
		if (stageGuard) {
			await updatePlannerStatus(ctx);
			return stageGuard;
		}
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
