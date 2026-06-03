import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { ALL_PLANNER_TOOL_NAMES } from "./guard/tool-policy";
import { readActivePlanContext } from "./runtime/active-plan";
import { createNodeFs } from "./storage/fs";
import { resolveProjectStoragePaths } from "./storage/project-resolver";

export interface RegisteredTool {
	name: string;
}

export function filterPlannerTools(tools: RegisteredTool[]): RegisteredTool[] {
	const plannerNames = new Set(ALL_PLANNER_TOOL_NAMES);
	return tools.filter((tool) => !plannerNames.has(tool.name));
}

export function registerPlannerToolVisibility(pi: ExtensionAPI): void {
	pi.on("before_provider_request", async (event, ctx) => {
		const fs = createNodeFs();
		const agentDir = getAgentDir();
		const projectPaths = await resolveProjectStoragePaths({
			fs,
			agentDir,
			cwd: ctx.cwd,
		});

		const context = await readActivePlanContext({ fs, projectPaths });

		const allTools = pi.getAllTools();

		let toolNames: string[];
		if (context.status === "ready") {
			// Active plan — show all tools
			toolNames = allTools.map((t) => t.name);
		} else {
			// No active plan — hide ALL planner tools
			const filteredTools = filterPlannerTools(allTools);
			toolNames = filteredTools.map((t) => t.name);
		}

		// Update state.tools so setActiveTools stays in sync
		pi.setActiveTools(toolNames);

		// Filter tools in the LLM context payload
		const payload = event.payload as {
			tools?: Array<{ name: string }>;
			[key: string]: unknown;
		};
		if (payload?.tools) {
			payload.tools = payload.tools.filter((t) => toolNames.includes(t.name));
		}

		return payload;
	});
}
