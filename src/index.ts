import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createNodeFs } from "./settings/fs";
import { ensurePlannerFiles } from "./settings/initializer";
import { loadPlannerSettings } from "./settings/loader";
import { createSettingsPaths } from "./settings/paths";

const EXTENSION_NAME = "pi-planner";

export default function register(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		const fs = createNodeFs();
		const paths = createSettingsPaths({
			agentDir: getAgentDir(),
			cwd: ctx.cwd,
			extensionName: EXTENSION_NAME,
		});

		const init = ensurePlannerFiles(paths, fs);
		const settings = loadPlannerSettings(paths, fs);

		ctx.ui.setStatus(
			EXTENSION_NAME,
			`planner ${settings.settings.refactor.maxIterations}r`,
		);

		if (init.created.length > 0) {
			ctx.ui.notify(
				`pi-planner initialized ${init.created.length} settings files`,
				"info",
			);
		}
	});
}
