import * as fs from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { ALL_PLANNER_TOOL_NAMES } from "./guard/tool-policy";
import { createNodeFs } from "./storage/fs";
import { createPlanStoragePaths } from "./storage/paths";
import { resolveProjectStoragePaths } from "./storage/project-resolver";

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
	// Do NOT call updateToolVisibility synchronously during extension load.
	// pi.getAllTools() / pi.setActiveTools() are action methods that cannot
	// be called during extension loading. Tool visibility will be updated
	// on session_start (first session) and before_provider_request.

	// On session start: check if activePlanId is set in project.json.
	// If so, activate planner tools; otherwise keep them hidden.
	// This handles /planner-create and /planner-switch which set activePlanId.
	pi.on("session_start", async (_event, ctx) => {
		await refreshPlanActiveCacheForSwitch(pi, ctx.cwd);
	});

	// Refresh tool visibility on every provider request (handles /planner-create, /planner-switch)
	pi.on("before_provider_request", async () => {
		updateToolVisibility(pi);
	});
}

/**
 * Check if activePlanId is set and update tool visibility accordingly.
 * Only activates plan when activePlanId is explicitly set (not on fresh session start).
 */
async function refreshPlanActiveCacheForSwitch(
	pi: ExtensionAPI,
	cwd: string,
): Promise<void> {
	try {
		const fsInstance = createNodeFs();
		const agentDir = getAgentDir();
		const projectPaths = await resolveProjectStoragePaths({
			fs: fsInstance,
			agentDir,
			cwd,
		});

		const projectJson = join(projectPaths.projectJson);
		if (!fs.existsSync(projectJson)) {
			planActiveCache = false;
			updateToolVisibility(pi);
			return;
		}

		const projectContent = fs.readFileSync(projectJson, "utf8");
		const project = JSON.parse(projectContent);
		if (project?.activePlanId) {
			const planPaths = createPlanStoragePaths(
				projectPaths,
				project.activePlanId,
			);
			if (
				fs.existsSync(planPaths.planJson) &&
				fs.existsSync(planPaths.stateJson)
			) {
				planActiveCache = true;
				updateToolVisibility(pi);
				return;
			}
		}
	} catch (_error) {
		// Ignore errors to avoid crashing startup/command flows
	}

	planActiveCache = false;
	updateToolVisibility(pi);
}
