import { join } from "node:path";
import { EXTENSION_NAME } from "../constants";
import { type PlannerFs, safeReaddir } from "./fs";
import { readJsonIfExists } from "./json";
import { createPlanStoragePaths, createProjectStoragePaths } from "./paths";
import type { ProjectRecord } from "./schema";

/**
 * One-time, idempotent migration of the on-disk layout to the unified scheme
 * where everything a project owns lives under projects/<projectId>/. Runs on
 * session start, best-effort: it must never throw into the host.
 *
 * Currently moves plans from the legacy flat extensionDir/plans/<planId> into
 * projects/<projectId>/plans/<planId>, attributing each plan via the owning
 * project.json (plans[] + activePlanId). A plan is moved only when the source
 * exists and the destination does not, so re-running is a no-op and a name
 * collision never destroys the source. Orphan plans (not referenced by any
 * project record) are left untouched in the legacy dir.
 */
export async function migrateLayout(input: {
	fs: PlannerFs;
	agentDir: string;
}): Promise<{ plansMoved: number }> {
	const { fs, agentDir } = input;
	const extensionDir = join(agentDir, "extensions", EXTENSION_NAME);
	const legacyPlansDir = join(extensionDir, "plans");
	const projectsDir = join(extensionDir, "projects");

	let plansMoved = 0;
	for (const projectId of await safeReaddir(fs, projectsDir)) {
		const projectJson = join(projectsDir, projectId, "project.json");
		const record = await readJsonIfExists<ProjectRecord>(fs, projectJson);
		if (!record?.projectRoot) continue;

		const projectPaths = createProjectStoragePaths({
			agentDir,
			projectRoot: record.projectRoot,
		});
		const planIds = new Set<string>();
		for (const plan of record.plans ?? []) {
			if (plan.planId) planIds.add(plan.planId);
		}
		if (record.activePlanId) planIds.add(record.activePlanId);

		for (const planId of planIds) {
			const src = join(legacyPlansDir, planId);
			const dst = createPlanStoragePaths(projectPaths, planId).planDir;
			if (!(await fs.exists(src))) continue;
			if (await fs.exists(dst)) continue;
			await fs.move(src, dst);
			plansMoved += 1;
		}
	}
	return { plansMoved };
}
