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

/**
 * Serializes read-modify-write on a single plan.json. The extension runs in
 * one process, but Pi executes every tool call in an assistant message
 * concurrently, so a batch of `planner_task_upsert` calls (the model authoring
 * all tasks at once) used to interleave their read → mutate → write on the one
 * shared plan.json: each read the same base, appended only its own task
 * summary, and the last writer clobbered the rest. Whole task summaries went
 * missing from `plan.tasks` (a task's task.json was written, but the plan
 * index never listed it), which made the coverage gate report its requirements
 * permanently DROPPED and starved execution of that task. An in-process queue
 * keyed by the plan.json path makes each mutation observe the previous one.
 */
const planWriteQueues = new Map<string, Promise<unknown>>();

export async function updatePlanRecord(
	fs: PlannerFs,
	paths: PlanStoragePaths,
	update: (record: PlanRecord) => PlanRecord,
): Promise<PlanRecord> {
	const key = paths.planJson;
	const prior = planWriteQueues.get(key) ?? Promise.resolve();
	const run = prior.then(async () => {
		const current = await readPlanRecord(fs, paths);
		const next = update(current);
		await savePlanRecord(fs, paths, next);
		return next;
	});
	// Keep the queue alive even if one mutation rejects, so a single failure
	// cannot wedge later writes; settle the tail either way. Drop the entry once
	// this call is the queue tail so the map does not grow without bound.
	const tail = run.then(
		() => undefined,
		() => undefined,
	);
	planWriteQueues.set(key, tail);
	void tail.then(() => {
		if (planWriteQueues.get(key) === tail) planWriteQueues.delete(key);
	});
	return run;
}

async function ensureTextFile(fs: PlannerFs, path: string): Promise<void> {
	if (!(await fs.exists(path))) {
		await fs.writeTextAtomic(path, "");
	}
}
