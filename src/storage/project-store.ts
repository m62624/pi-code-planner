import type { PlannerFs } from "./fs";
import { readJson, readJsonIfExists, writeJson } from "./json";
import type { ProjectStoragePaths } from "./paths";
import {
	createEmptyProjectRecord,
	type ProjectPlanSummary,
	type ProjectRecord,
} from "./schema";

export async function ensureProjectRecord(
	fs: PlannerFs,
	paths: ProjectStoragePaths,
): Promise<ProjectRecord> {
	const existing = await readProjectRecordIfExists(fs, paths);
	if (existing) {
		return existing;
	}

	const record = createEmptyProjectRecord({
		projectId: paths.projectId,
		projectRoot: paths.projectRoot,
		displayName: paths.displayName,
	});
	await saveProjectRecord(fs, paths, record);
	return record;
}

export async function readProjectRecord(
	fs: PlannerFs,
	paths: ProjectStoragePaths,
): Promise<ProjectRecord> {
	return await readJson<ProjectRecord>(fs, paths.projectJson);
}

export async function readProjectRecordIfExists(
	fs: PlannerFs,
	paths: ProjectStoragePaths,
): Promise<ProjectRecord | null> {
	return await readJsonIfExists<ProjectRecord>(fs, paths.projectJson);
}

export async function saveProjectRecord(
	fs: PlannerFs,
	paths: ProjectStoragePaths,
	record: ProjectRecord,
): Promise<void> {
	await fs.mkdirp(paths.plansDir);
	await writeJson(fs, paths.projectJson, record);
}

export async function updateProjectRecord(
	fs: PlannerFs,
	paths: ProjectStoragePaths,
	update: (record: ProjectRecord) => ProjectRecord,
): Promise<ProjectRecord> {
	const current = await ensureProjectRecord(fs, paths);
	const next = update(current);
	await saveProjectRecord(fs, paths, next);
	return next;
}

export async function setActivePlan(
	fs: PlannerFs,
	paths: ProjectStoragePaths,
	planId: string | null,
): Promise<ProjectRecord> {
	return await updateProjectRecord(fs, paths, (record) => ({
		...record,
		activePlanId: planId,
	}));
}

export async function upsertProjectPlanSummary(
	fs: PlannerFs,
	paths: ProjectStoragePaths,
	summary: ProjectPlanSummary,
): Promise<ProjectRecord> {
	return await updateProjectRecord(fs, paths, (record) => {
		const plans = record.plans.filter((plan) => plan.planId !== summary.planId);
		plans.push(summary);
		return { ...record, plans };
	});
}
