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
		expect(settings.effective.idle).toEqual({
			enabled: true,
			timeoutMinutes: 10,
		});
		expect(settings.effective.metadata).toEqual({
			humanLanguage: "English",
			titleLanguage: "English",
			descriptionLanguage: "English",
			commitLanguage: "English",
			doubtReviewLanguage: "English",
			skillLanguage: "English",
		});
		expect(settings.effective.timer).toEqual({
			enabled: true,
			mode: "status",
			showCheckpoints: true,
			maxCheckpoints: 5,
			syncIntervalMinutes: 10,
		});
		expect(settings.effective.skills).toEqual({
			enabled: true,
			maxActive: 0,
		});
		expect(settings.effective.contracts).toEqual({
			enabled: true,
			finalPolicy: "ask",
			scanBatchSize: 10,
			statusCharBudget: 12000,
			readChunkChars: 6000,
			maxActiveChains: 3,
			levelBudgets: {
				root: 1800,
				ancestor: 3000,
				nearest: 7000,
			},
		});
		expect(settings.effective.workspace).toEqual({
			enabled: true,
			autoOpen: true,
			footerReserveRows: 3,
		});
		expect(settings.worktreeSource).toBe("global");
		expect(
			fs.snapshot()["/agent/extensions/pi-code-planner/settings.json"],
		).toBe(
			'{\n  "worktree": {\n    "mode": "project-local"\n  },\n  "idle": {\n    "enabled": true,\n    "timeoutMinutes": 10\n  },\n  "metadata": {\n    "humanLanguage": "English"\n  },\n  "timer": {\n    "enabled": true,\n    "mode": "status",\n    "showCheckpoints": true,\n    "maxCheckpoints": 5,\n    "syncIntervalMinutes": 10\n  },\n  "skills": {\n    "enabled": true,\n    "maxActive": 0\n  },\n  "contracts": {\n    "enabled": true,\n    "finalPolicy": "ask",\n    "scanBatchSize": 10,\n    "statusCharBudget": 12000,\n    "readChunkChars": 6000,\n    "maxActiveChains": 3,\n    "levelBudgets": {\n      "root": 1800,\n      "ancestor": 3000,\n      "nearest": 7000\n    }\n  },\n  "workspace": {\n    "enabled": true,\n    "autoOpen": true,\n    "footerReserveRows": 3\n  }\n}\n',
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

	it("warns about deprecated and unknown keys without failing to parse", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		await fs.writeTextAtomic(
			"/agent/extensions/pi-code-planner/settings.json",
			JSON.stringify({
				contracts: { requireAfterTdd: true, bogusKey: 1 },
				mysteryGroup: { a: 1 },
			}),
		);

		const settings = await loadEffectivePlannerSettings({ fs, projectPaths });

		// The JSON still loads and known defaults stay intact.
		expect(settings.effective.contracts.enabled).toBe(true);
		const joined = settings.warnings.join("\n");
		expect(joined).toContain("contracts.requireAfterTdd");
		expect(joined).toContain("deprecated");
		expect(joined).toContain("contracts.bogusKey");
		expect(joined).toContain("mysteryGroup");
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
			humanLanguage: "English",
			titleLanguage: "English",
			descriptionLanguage: "Russian",
			commitLanguage: "English",
			doubtReviewLanguage: "English",
			skillLanguage: "English",
		});
		expect(settings.metadataSource).toBe("project");
	});

	it("lets human metadata language feed individual language defaults", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		await fs.writeTextAtomic(
			"/agent/extensions/pi-code-planner/settings.json",
			'{ "metadata": { "humanLanguage": "Russian" } }\n',
		);
		await fs.writeTextAtomic(
			"/repo/app/.pi/pi-code-planner/settings.json",
			'{ "metadata": { "descriptionLanguage": "Kazakh" } }\n',
		);

		const settings = await loadEffectivePlannerSettings({ fs, projectPaths });

		expect(settings.effective.metadata).toEqual({
			humanLanguage: "Russian",
			titleLanguage: "Russian",
			descriptionLanguage: "Kazakh",
			commitLanguage: "Russian",
			doubtReviewLanguage: "Russian",
			skillLanguage: "Russian",
		});
		expect(settings.metadataSource).toBe("project");
	});

	it("lets project human language override global component defaults", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		await fs.writeTextAtomic(
			"/agent/extensions/pi-code-planner/settings.json",
			'{ "metadata": { "titleLanguage": "English", "commitLanguage": "English" } }\n',
		);
		await fs.writeTextAtomic(
			"/repo/app/.pi/pi-code-planner/settings.json",
			'{ "metadata": { "humanLanguage": "Russian" } }\n',
		);

		const settings = await loadEffectivePlannerSettings({ fs, projectPaths });

		expect(settings.effective.metadata).toEqual({
			humanLanguage: "Russian",
			titleLanguage: "Russian",
			descriptionLanguage: "Russian",
			commitLanguage: "Russian",
			doubtReviewLanguage: "Russian",
			skillLanguage: "Russian",
		});
	});

	it("lets project metadata settings override skill language", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		await fs.writeTextAtomic(
			"/agent/extensions/pi-code-planner/settings.json",
			'{ "metadata": { "skillLanguage": "English" } }\n',
		);
		await fs.writeTextAtomic(
			"/repo/app/.pi/pi-code-planner/settings.json",
			'{ "metadata": { "skillLanguage": "Russian" } }\n',
		);

		const settings = await loadEffectivePlannerSettings({ fs, projectPaths });

		expect(settings.effective.metadata.skillLanguage).toBe("Russian");
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

	it("lets project contracts settings override nested budget fields", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		await fs.writeTextAtomic(
			"/agent/extensions/pi-code-planner/settings.json",
			'{ "contracts": { "finalPolicy": "keep", "levelBudgets": { "nearest": 5000 } } }\n',
		);
		await fs.writeTextAtomic(
			"/repo/app/.pi/pi-code-planner/settings.json",
			'{ "contracts": { "scanBatchSize": 4, "levelBudgets": { "root": 900 } } }\n',
		);

		const settings = await loadEffectivePlannerSettings({ fs, projectPaths });

		expect(settings.effective.contracts).toMatchObject({
			finalPolicy: "keep",
			scanBatchSize: 4,
			levelBudgets: {
				root: 900,
				ancestor: 3000,
				nearest: 5000,
			},
		});
		expect(settings.contractsSource).toBe("project");
	});

	it("lets project skills settings override global skill loading settings", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		await fs.writeTextAtomic(
			"/agent/extensions/pi-code-planner/settings.json",
			'{ "skills": { "enabled": true, "maxActive": 8 } }\n',
		);
		await fs.writeTextAtomic(
			"/repo/app/.pi/pi-code-planner/settings.json",
			'{ "skills": { "maxActive": 2 } }\n',
		);

		const settings = await loadEffectivePlannerSettings({ fs, projectPaths });

		expect(settings.effective.skills).toEqual({
			enabled: true,
			maxActive: 2,
		});
		expect(settings.skillsSource).toBe("project");
	});

	it("rejects negative skills maxActive settings", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		await fs.writeTextAtomic(
			"/agent/extensions/pi-code-planner/settings.json",
			'{ "skills": { "maxActive": -1 } }\n',
		);

		await expect(
			loadEffectivePlannerSettings({ fs, projectPaths }),
		).rejects.toThrow("skills.maxActive");
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
