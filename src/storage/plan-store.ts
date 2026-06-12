import type { PlannerFs } from "./fs";
import { readJson, readJsonIfExists, writeJson } from "./json";
import type { PlanStoragePaths } from "./paths";
import type { PlanRecord } from "./schema";

export async function initializePlanFiles(
	fs: PlannerFs,
	paths: PlanStoragePaths,
	plan: PlanRecord,
): Promise<PlanRecord> {
	await fs.mkdirp(paths.tasksDir);
	await fs.mkdirp(paths.contractsBaselineDir);
	await savePlanRecord(fs, paths, plan);
	await ensureTextFile(fs, paths.requestMd);
	await ensureTextFile(fs, paths.goalMd);
	await ensureTextFile(fs, paths.planMd);
	await ensureTextFile(fs, paths.discoveryMd);
	await ensureTextFile(fs, paths.questionsMd);
	await ensureTextFile(fs, paths.decisionsMd);
	await ensureTextFile(fs, paths.verifyMd);
	return plan;
}

export async function readPlanRecord(
	fs: PlannerFs,
	paths: PlanStoragePaths,
): Promise<PlanRecord> {
	return await readJson<PlanRecord>(fs, paths.planJson);
}

export async function readPlanRecordIfExists(
	fs: PlannerFs,
	paths: PlanStoragePaths,
): Promise<PlanRecord | null> {
	return await readJsonIfExists<PlanRecord>(fs, paths.planJson);
}

export async function savePlanRecord(
	fs: PlannerFs,
	paths: PlanStoragePaths,
	record: PlanRecord,
): Promise<void> {
	await fs.mkdirp(paths.planDir);
	await writeJson(fs, paths.planJson, record);
}

export async function updatePlanRecord(
	fs: PlannerFs,
	paths: PlanStoragePaths,
	update: (record: PlanRecord) => PlanRecord,
): Promise<PlanRecord> {
	const current = await readPlanRecord(fs, paths);
	const next = update(current);
	await savePlanRecord(fs, paths, next);
	return next;
}

async function ensureTextFile(fs: PlannerFs, path: string): Promise<void> {
	if (!(await fs.exists(path))) {
		await fs.writeTextAtomic(path, "");
	}
}
