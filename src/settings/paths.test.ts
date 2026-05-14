import { describe, expect, it } from "vitest";
import { createSettingsPaths } from "./paths";

describe("createSettingsPaths", () => {
	it("creates global and project extension paths", () => {
		const paths = createSettingsPaths({
			agentDir: "/home/user/.pi/agent",
			cwd: "/repo",
			extensionName: "pi-planner",
		});

		expect(paths.globalSettings).toBe(
			"/home/user/.pi/agent/extensions/pi-planner/settings.json",
		);
		expect(paths.projectSettings).toBe(
			"/repo/.pi/extensions/pi-planner/settings.json",
		);
	});
});
