import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { ALL_PLANNER_TOOL_NAMES } from "./guard/tool-policy";
import { readActivePlanContext } from "./runtime/active-plan";
import { createNodeFs } from "./storage/fs";
import { resolveProjectStoragePaths } from "./storage/project-resolver";

export interface RegisteredTool {
	name: string;
}

const plannerNames = new Set(ALL_PLANNER_TOOL_NAMES);

/** Cached plan active state — false by default, updated after planner commands. */
let planActiveCache: boolean = false;

export function filterPlannerTools(tools: RegisteredTool[]): RegisteredTool[] {
	return tools.filter((tool) => !plannerNames.has(tool.name));
}

/** Refresh the plan-active cache by reading from disk. */
export async function refreshPlanActiveCache(cwd: string): Promise<boolean> {
	const fs = createNodeFs();
	const agentDir = getAgentDir();
	const projectPaths = await resolveProjectStoragePaths({
		fs,
		agentDir,
		cwd,
	});

	const context = await readActivePlanContext({ fs, projectPaths });
	planActiveCache = context.status === "ready";
	return planActiveCache;
}

/** Reset the cache to inactive (called after /planner-accept, /planner-delete). */
export function resetPlanActiveCache(): void {
	planActiveCache = false;
}

export function registerPlannerToolVisibility(pi: ExtensionAPI): void {
	// Refresh cache once at session start
	pi.on("session_start", async (_event, ctx) => {
		await refreshPlanActiveCache(ctx.cwd);
	});

	// Only update UI tool visibility — do NOT modify payload (breaks Pi tool execution)
	pi.on("before_provider_request", async () => {
		const allTools = pi.getAllTools();

		const toolNames = planActiveCache
			? allTools.map((t) => t.name)
			: filterPlannerTools(allTools).map((t) => t.name);

		pi.setActiveTools(toolNames);
	});
}
