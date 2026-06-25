import { describe, expect, it } from "vitest";
import { MockPlannerFs } from "../test/mock-fs";
import { writeJson } from "./json";
import { migrateLayout } from "./migrate-layout";
import { createPlanStoragePaths, createProjectStoragePaths } from "./paths";
import type { ProjectRecord } from "./schema";

const AGENT_DIR = "/agent";

async function seedProject(
	fs: MockPlannerFs,
	projectRoot: string,
	record: Partial<ProjectRecord>,
): Promise<ReturnType<typeof createProjectStoragePaths>> {
	const paths = createProjectStoragePaths({ agentDir: AGENT_DIR, projectRoot });
	await writeJson(fs, paths.projectJson, {
		schemaVersion: 1,
		projectId: paths.projectId,
		projectRoot,
		displayName: paths.displayName,
		activePlanId: null,
		plans: [],
		...record,
	} satisfies ProjectRecord);
	return paths;
}

function legacyPlanDir(planId: string): string {
	return `${AGENT_DIR}/extensions/pi-code-planner/plans/${planId}`;
}

describe("migrateLayout", () => {
	it("moves flat plans into the owning project dir", async () => {
		const fs = new MockPlannerFs();
		const projectRoot = "/home/me/app";
		const paths = await seedProject(fs, projectRoot, {
			activePlanId: "plan-a",
			plans: [{ planId: "plan-a", title: "A", status: "active" }],
		});
		await fs.writeText(`${legacyPlanDir("plan-a")}/plan.json`, "{}");
		await fs.writeText(
			`${legacyPlanDir("plan-a")}/tasks/t1/task.json`,
			'{"taskId":"t1"}',
		);

		const result = await migrateLayout({ fs, agentDir: AGENT_DIR });

		expect(result.plansMoved).toBe(1);
		const dst = createPlanStoragePaths(paths, "plan-a").planDir;
		expect(await fs.exists(`${dst}/plan.json`)).toBe(true);
		expect(await fs.exists(`${dst}/tasks/t1/task.json`)).toBe(true);
		expect(await fs.exists(`${legacyPlanDir("plan-a")}/plan.json`)).toBe(false);
		// The now-empty legacy flat plans dir is cleaned up.
		expect(
			await fs.exists(`${AGENT_DIR}/extensions/pi-code-planner/plans`),
		).toBe(false);
	});

	it("picks up the active plan even if absent from plans[]", async () => {
		const fs = new MockPlannerFs();
		const paths = await seedProject(fs, "/home/me/app", {
			activePlanId: "plan-active",
			plans: [],
		});
		await fs.writeText(`${legacyPlanDir("plan-active")}/plan.json`, "{}");

		const result = await migrateLayout({ fs, agentDir: AGENT_DIR });

		expect(result.plansMoved).toBe(1);
		const dst = createPlanStoragePaths(paths, "plan-active").planDir;
		expect(await fs.exists(`${dst}/plan.json`)).toBe(true);
	});

	it("is idempotent — a second run moves nothing", async () => {
		const fs = new MockPlannerFs();
		await seedProject(fs, "/home/me/app", {
			plans: [{ planId: "plan-a", title: "A", status: "active" }],
		});
		await fs.writeText(`${legacyPlanDir("plan-a")}/plan.json`, "{}");

		expect((await migrateLayout({ fs, agentDir: AGENT_DIR })).plansMoved).toBe(
			1,
		);
		expect((await migrateLayout({ fs, agentDir: AGENT_DIR })).plansMoved).toBe(
			0,
		);
	});

	it("never destroys the source on a destination collision", async () => {
		const fs = new MockPlannerFs();
		const paths = await seedProject(fs, "/home/me/app", {
			plans: [{ planId: "plan-a", title: "A", status: "active" }],
		});
		await fs.writeText(`${legacyPlanDir("plan-a")}/plan.json`, "legacy");
		const dst = createPlanStoragePaths(paths, "plan-a").planDir;
		await fs.writeText(`${dst}/plan.json`, "already-here");

		const result = await migrateLayout({ fs, agentDir: AGENT_DIR });

		expect(result.plansMoved).toBe(0);
		expect(await fs.readText(`${dst}/plan.json`)).toBe("already-here");
		expect(await fs.readText(`${legacyPlanDir("plan-a")}/plan.json`)).toBe(
			"legacy",
		);
	});

	it("drops the stale skills/bundled dir but keeps the legacy global user pool", async () => {
		const fs = new MockPlannerFs();
		await seedProject(fs, "/home/me/app", { plans: [] });
		const ext = `${AGENT_DIR}/extensions/pi-code-planner`;
		await fs.writeText(`${ext}/skills/bundled/elenchus/SKILL.md`, "# old");
		await fs.writeText(
			`${ext}/skills/library/legacy/SKILL.md`,
			"# legacy user",
		);
		await fs.writeText(`${ext}/skills/index.json`, "{}");

		await migrateLayout({ fs, agentDir: AGENT_DIR });

		expect(await fs.exists(`${ext}/skills/bundled`)).toBe(false);
		// The legacy global user pool stays for the read-only discovery fallback,
		// so the skills dir itself is kept.
		expect(await fs.exists(`${ext}/skills/library/legacy/SKILL.md`)).toBe(true);
		expect(await fs.exists(`${ext}/skills/index.json`)).toBe(true);
		expect(await fs.exists(`${ext}/skills`)).toBe(true);
	});

	it("removes the legacy skills dir when only the stale bundled copy existed", async () => {
		const fs = new MockPlannerFs();
		await seedProject(fs, "/home/me/app", { plans: [] });
		const ext = `${AGENT_DIR}/extensions/pi-code-planner`;
		await fs.writeText(`${ext}/skills/bundled/elenchus/SKILL.md`, "# old");

		await migrateLayout({ fs, agentDir: AGENT_DIR });

		// No legacy user pool remained, so the whole skills dir is cleaned up.
		expect(await fs.exists(`${ext}/skills`)).toBe(false);
	});

	it("keeps the legacy plans dir when an orphan plan remains", async () => {
		const fs = new MockPlannerFs();
		const paths = await seedProject(fs, "/home/me/app", {
			plans: [{ planId: "plan-a", title: "A", status: "active" }],
		});
		await fs.writeText(`${legacyPlanDir("plan-a")}/plan.json`, "{}");
		await fs.writeText(`${legacyPlanDir("orphan")}/plan.json`, "{}");

		await migrateLayout({ fs, agentDir: AGENT_DIR });

		// plan-a moved out, but the orphan keeps the legacy dir alive.
		expect(
			await fs.exists(createPlanStoragePaths(paths, "plan-a").planDir),
		).toBe(true);
		expect(await fs.exists(`${legacyPlanDir("orphan")}/plan.json`)).toBe(true);
		expect(
			await fs.exists(`${AGENT_DIR}/extensions/pi-code-planner/plans`),
		).toBe(true);
	});

	it("leaves orphan plans (not referenced by any project) untouched", async () => {
		const fs = new MockPlannerFs();
		await seedProject(fs, "/home/me/app", { plans: [] });
		await fs.writeText(`${legacyPlanDir("orphan")}/plan.json`, "{}");

		const result = await migrateLayout({ fs, agentDir: AGENT_DIR });

		expect(result.plansMoved).toBe(0);
		expect(await fs.exists(`${legacyPlanDir("orphan")}/plan.json`)).toBe(true);
	});
});
