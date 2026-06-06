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
		});
		expect(settings.effective.idle).toEqual({
			enabled: true,
			timeoutMinutes: 10,
		});
		expect(settings.effective.metadata).toEqual({
			descriptionLanguage: "English",
		});
		expect(settings.effective.timer).toEqual({
			enabled: true,
			mode: "status",
			showCheckpoints: true,
			maxCheckpoints: 5,
			syncIntervalMinutes: 10,
		});
		expect(settings.worktreeSource).toBe("global");
		expect(
			fs.snapshot()["/agent/extensions/pi-code-planner/settings.json"],
		).toBe(
			'{\n  "worktree": {\n    "mode": "project-local"\n  },\n  "compact": {\n    "stage": true,\n    "task": false\n  },\n  "idle": {\n    "enabled": true,\n    "timeoutMinutes": 10\n  },\n  "metadata": {\n    "descriptionLanguage": "English"\n  },\n  "timer": {\n    "enabled": true,\n    "mode": "status",\n    "showCheckpoints": true,\n    "maxCheckpoints": 5,\n    "syncIntervalMinutes": 10\n  }\n}\n',
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
			'{ "compact": { "stage": true, "task": true } }\n',
		);
		await fs.writeTextAtomic(
			"/repo/app/.pi/pi-code-planner/settings.json",
			'{ "compact": { "task": false } }\n',
		);

		const settings = await loadEffectivePlannerSettings({ fs, projectPaths });

		expect(settings.effective.compact).toEqual({
			stage: true,
			task: false,
		});
		expect(settings.compactSource).toBe("project");
	});

	it("lets project idle timeout override the global default", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		await fs.writeTextAtomic(
			"/agent/extensions/pi-code-planner/settings.json",
			'{ "idle": { "timeoutMinutes": 20 } }\n',
		);
		await fs.writeTextAtomic(
			"/repo/app/.pi/pi-code-planner/settings.json",
			'{ "idle": { "enabled": false } }\n',
		);

		const settings = await loadEffectivePlannerSettings({ fs, projectPaths });

		expect(settings.effective.idle).toEqual({
			enabled: false,
			timeoutMinutes: 20,
		});
		expect(settings.idleSource).toBe("project");
	});

	it("rejects non-positive idle timeout settings", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		await fs.writeTextAtomic(
			"/agent/extensions/pi-code-planner/settings.json",
			'{ "idle": { "timeoutMinutes": 0 } }\n',
		);

		await expect(
			loadEffectivePlannerSettings({ fs, projectPaths }),
		).rejects.toThrow("timeoutMinutes");
	});

	it("lets project metadata settings override description language", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		await fs.writeTextAtomic(
			"/agent/extensions/pi-code-planner/settings.json",
			'{ "metadata": { "descriptionLanguage": "English" } }\n',
		);
		await fs.writeTextAtomic(
			"/repo/app/.pi/pi-code-planner/settings.json",
			'{ "metadata": { "descriptionLanguage": "Russian" } }\n',
		);

		const settings = await loadEffectivePlannerSettings({ fs, projectPaths });

		expect(settings.effective.metadata).toEqual({
			descriptionLanguage: "Russian",
		});
		expect(settings.metadataSource).toBe("project");
	});

	it("rejects empty metadata description language", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		await fs.writeTextAtomic(
			"/agent/extensions/pi-code-planner/settings.json",
			'{ "metadata": { "descriptionLanguage": " " } }\n',
		);

		await expect(
			loadEffectivePlannerSettings({ fs, projectPaths }),
		).rejects.toThrow("descriptionLanguage");
	});

	it("lets project timer settings override individual global timer settings", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		await fs.writeTextAtomic(
			"/agent/extensions/pi-code-planner/settings.json",
			'{ "timer": { "mode": "widget", "maxCheckpoints": 9 } }\n',
		);
		await fs.writeTextAtomic(
			"/repo/app/.pi/pi-code-planner/settings.json",
			'{ "timer": { "enabled": false, "syncIntervalMinutes": 3 } }\n',
		);

		const settings = await loadEffectivePlannerSettings({ fs, projectPaths });

		expect(settings.effective.timer).toEqual({
			enabled: false,
			mode: "widget",
			showCheckpoints: true,
			maxCheckpoints: 9,
			syncIntervalMinutes: 3,
		});
		expect(settings.timerSource).toBe("project");
	});

	it("rejects invalid timer mode", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		await fs.writeTextAtomic(
			"/agent/extensions/pi-code-planner/settings.json",
			'{ "timer": { "mode": "overlay" } }\n',
		);

		await expect(
			loadEffectivePlannerSettings({ fs, projectPaths }),
		).rejects.toThrow("mode");
	});

	it("rejects invalid timer sync interval", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		await fs.writeTextAtomic(
			"/agent/extensions/pi-code-planner/settings.json",
			'{ "timer": { "syncIntervalMinutes": 0 } }\n',
		);

		await expect(
			loadEffectivePlannerSettings({ fs, projectPaths }),
		).rejects.toThrow("syncIntervalMinutes");
	});
});
