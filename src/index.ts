import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createGitCore, type GitCore } from "./git/core";
import {
	checkPlannerToolCall,
	checkPlannerUserBash,
} from "./git/tool-call-events";
import { createPlannerGitTools } from "./tools/planner-git-tools";

const EXTENSION_NAME = "pi-planner";

export default function register(pi: ExtensionAPI): void {
	const cores = new Map<string, GitCore>();

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

	for (const tool of createPlannerGitTools(getCore)) {
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
		return checkPlannerToolCall(getCore(ctx.cwd), event);
	});

	pi.on("user_bash", async (event) => {
		return checkPlannerUserBash(getCore(event.cwd), event);
	});
}
