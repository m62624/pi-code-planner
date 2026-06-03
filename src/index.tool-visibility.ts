import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ALL_PLANNER_TOOL_NAMES } from "./guard/tool-policy";

export interface RegisteredTool {
	name: string;
}

const plannerNames: Set<string> = new Set(ALL_PLANNER_TOOL_NAMES);

/** Cached plan active state — false by default, updated after planner commands. */
let planActiveCache: boolean = false;

export function filterPlannerTools(tools: RegisteredTool[]): RegisteredTool[] {
	return tools.filter((tool) => !plannerNames.has(tool.name));
}

/** Synchronously check if a plan is active. */
export function refreshPlanActiveCacheSync(
	pi: ExtensionAPI,
	_cwd: string,
): boolean {
	// Do NOT auto-activate plan. activePlanId is only set via
	// /planner-create or /planner-switch. On session start (including
	// resumed sessions) the plan must NOT be auto-activated.
	planActiveCache = false;
	updateToolVisibility(pi);
	return false;
}

/** Refresh the plan-active cache by reading from disk. */
export async function refreshPlanActiveCache(
	pi: ExtensionAPI,
	_cwd: string,
): Promise<boolean> {
	// Do NOT auto-activate plan. activePlanId is only set via
	// /planner-create or /planner-switch. On session start the plan
	// must NOT be auto-activated.
	planActiveCache = false;
	updateToolVisibility(pi);
	return false;
}

/** Reset the cache to inactive (called after /planner-accept, /planner-delete). */
export function resetPlanActiveCache(pi: ExtensionAPI): void {
	planActiveCache = false;
	updateToolVisibility(pi);
}

/** Update the list of active tools in the Pi extension API. */
export function updateToolVisibility(pi: ExtensionAPI): void {
	const allTools = pi.getAllTools();
	const toolNames = planActiveCache
		? allTools.map((t) => t.name)
		: filterPlannerTools(allTools).map((t) => t.name);

	pi.setActiveTools(toolNames);
}

export function registerPlannerToolVisibility(pi: ExtensionAPI): void {
	// Do NOT auto-activate plan on session start. Plan is only active when
	// explicitly set via /planner-create or /planner-switch. A session restart
	// (e.g. ESC → resumed session) must not re-activate a plan.

	// Only update UI tool visibility — do NOT modify payload (breaks Pi tool execution)
	pi.on("before_provider_request", async () => {
		updateToolVisibility(pi);
	});
}
