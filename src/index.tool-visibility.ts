import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { ALL_PLANNER_TOOL_NAMES } from "./guard/tool-policy";
import { readActivePlanContext } from "./runtime/active-plan";
import { createNodeFs } from "./storage/fs";
import {
	createPlanStoragePaths,
	createProjectStoragePaths,
} from "./storage/paths";
import { resolveProjectStoragePaths } from "./storage/project-resolver";
import { createWorktreeProjectIndexPath } from "./storage/worktree-index";

export interface RegisteredTool {
	name: string;
}

const plannerNames = new Set(ALL_PLANNER_TOOL_NAMES);

/** Cached plan active state — false by default, updated after planner commands. */
let planActiveCache: boolean = false;

export function filterPlannerTools(tools: RegisteredTool[]): RegisteredTool[] {
	return tools.filter((tool) => !plannerNames.has(tool.name));
}

/** Synchronously check if a plan is active. */
export function refreshPlanActiveCacheSync(
	pi: ExtensionAPI,
	cwd: string,
): boolean {
	try {
		const agentDir = getAgentDir();
		const direct = createProjectStoragePaths({
			agentDir,
			projectRoot: cwd,
		});

		let projectPaths = direct;
		if (!fs.existsSync(direct.projectJson)) {
			const indexFile = createWorktreeProjectIndexPath({
				agentDir,
				worktreePath: cwd,
			});
			if (fs.existsSync(indexFile)) {
				const indexContent = fs.readFileSync(indexFile, "utf8");
				const indexRecord = JSON.parse(indexContent);
				if (indexRecord?.projectRoot) {
					projectPaths = createProjectStoragePaths({
						agentDir,
						projectRoot: indexRecord.projectRoot,
					});
				}
			}
		}

		if (fs.existsSync(projectPaths.projectJson)) {
			const projectContent = fs.readFileSync(projectPaths.projectJson, "utf8");
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
					return true;
				}
			}
		}
	} catch (_error) {
		// Ignore sync errors to avoid crashing startup/command flows
	}

	planActiveCache = false;
	updateToolVisibility(pi);
	return false;
}

/** Refresh the plan-active cache by reading from disk. */
export async function refreshPlanActiveCache(
	pi: ExtensionAPI,
	cwd: string,
): Promise<boolean> {
	const fsInstance = createNodeFs();
	const agentDir = getAgentDir();
	const projectPaths = await resolveProjectStoragePaths({
		fs: fsInstance,
		agentDir,
		cwd,
	});

	const context = await readActivePlanContext({
		fs: fsInstance,
		projectPaths,
	});
	planActiveCache = context.status === "ready";
	updateToolVisibility(pi);
	return planActiveCache;
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
	// Refresh cache on session start (using sync check for zero lag, then async check for safety)
	pi.on("session_start", async (_event, ctx) => {
		refreshPlanActiveCacheSync(pi, ctx.cwd);
		await refreshPlanActiveCache(pi, ctx.cwd);
	});

	// Only update UI tool visibility — do NOT modify payload (breaks Pi tool execution)
	pi.on("before_provider_request", async () => {
		updateToolVisibility(pi);
	});
}
