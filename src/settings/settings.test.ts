import { describe, expect, it } from "vitest";
import { createProjectStoragePaths } from "../storage/paths";
import { MockPlannerFs } from "../test/mock-fs";
import { loadEffectivePlannerSettings } from "./manager";

describe("planner settings", () => {
	it("creates global default settings when missing", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});

		const settings = await loadEffectivePlannerSettings({ fs, projectPaths });

		expect(settings.effective.worktree).toEqual({ mode: "project-local" });
		expect(settings.effective.compact).toEqual({
			stage: true,
			task: false,
			experiment: false,
		});
		expect(settings.worktreeSource).toBe("global");
		expect(
			fs.snapshot()["/agent/extensions/pi-code-planner/settings.json"],
		).toBe(
			'{\n  "worktree": {\n    "mode": "project-local"\n  },\n  "compact": {\n    "stage": true,\n    "task": false,\n    "experiment": false\n  }\n}\n',
		);
	});

	it("uses global custom worktree settings when project settings are absent", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		await fs.writeTextAtomic(
			"/agent/extensions/pi-code-planner/settings.json",
			'{ "worktree": { "mode": "custom", "root": " /tmp/worktrees " } }\n',
		);

		const settings = await loadEffectivePlannerSettings({ fs, projectPaths });

		expect(settings.effective.worktree).toEqual({
			mode: "custom",
			root: "/tmp/worktrees",
		});
		expect(settings.worktreeSource).toBe("global");
	});

	it("lets project worktree settings override global worktree settings as a whole", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		await fs.writeTextAtomic(
			"/agent/extensions/pi-code-planner/settings.json",
			'{ "worktree": { "mode": "custom", "root": "/global" } }\n',
		);
		await fs.writeTextAtomic(
			"/repo/app/.pi/pi-code-planner/settings.json",
			'{ "worktree": { "mode": "project-local" } }\n',
		);

		const settings = await loadEffectivePlannerSettings({ fs, projectPaths });

		expect(settings.effective.worktree).toEqual({ mode: "project-local" });
		expect(settings.worktreeSource).toBe("project");
	});

	it("rejects custom worktree settings without a root", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		await fs.writeTextAtomic(
			"/agent/extensions/pi-code-planner/settings.json",
			'{ "worktree": { "mode": "custom" } }\n',
		);

		await expect(
			loadEffectivePlannerSettings({ fs, projectPaths }),
		).rejects.toThrow("require a non-empty root");
	});

	it("lets project compact settings override individual global boundaries", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		await fs.writeTextAtomic(
			"/agent/extensions/pi-code-planner/settings.json",
			'{ "compact": { "stage": true, "task": true, "experiment": false } }\n',
		);
		await fs.writeTextAtomic(
			"/repo/app/.pi/pi-code-planner/settings.json",
			'{ "compact": { "experiment": true } }\n',
		);

		const settings = await loadEffectivePlannerSettings({ fs, projectPaths });

		expect(settings.effective.compact).toEqual({
			stage: true,
			task: true,
			experiment: true,
		});
		expect(settings.compactSource).toBe("project");
	});
});
