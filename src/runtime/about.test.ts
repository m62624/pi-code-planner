import { describe, expect, it } from "vitest";
import { loadEffectivePlannerSettings } from "../settings/manager";
import { createProjectStoragePaths } from "../storage/paths";
import { MockPlannerFs } from "../test/mock-fs";
import { buildPlannerAboutReport } from "./about";

describe("planner about report", () => {
	it("explains current settings, defaults, and sources from one settings core", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		await fs.writeTextAtomic(
			"/agent/extensions/pi-code-planner/settings.json",
			'{ "idle": { "timeoutMinutes": 20 }, "skills": { "maxActive": 3 } }\n',
		);
		await fs.writeTextAtomic(
			"/repo/app/.pi/pi-code-planner/settings.json",
			'{ "timer": { "mode": "widget" } }\n',
		);
		const settings = await loadEffectivePlannerSettings({ fs, projectPaths });

		const report = buildPlannerAboutReport({
			settings,
			projectPaths,
			audience: "agent",
		});

		expect(report).toContain("# Planner About");
		expect(report).toContain("/planner-improve");
		expect(report).toContain("AGENTS.md");
		expect(report).toContain("GEMINI.md");
		expect(report).toContain(".cursorrules");
		expect(report).toContain(
			"| `idle.timeoutMinutes` | `20` | `10` | global |",
		);
		expect(report).toContain(
			'| `timer.mode` | `"widget"` | `"status"` | project |',
		);
		expect(report).toContain("| `skills.maxActive` | `3` | `0` | global |");
	});
});
