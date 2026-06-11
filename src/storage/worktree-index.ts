import { createHash } from "node:crypto";
import { join, normalize } from "node:path";
import { EXTENSION_NAME, SCHEMA_VERSION } from "../constants";
import type { PlannerFs } from "./fs";
import { readJsonIfExists, writeJson } from "./json";

export interface WorktreeProjectIndexRecord {
	schemaVersion: typeof SCHEMA_VERSION;
	worktreePath: string;
	projectRoot: string;
	projectId: string;
	planId: string;
	createdFromSessionFile?: string | null;
	lastRootSessionFile?: string | null;
}

export function createWorktreeProjectIndexPath(input: {
	agentDir: string;
	worktreePath: string;
}): string {
	const hash = createHash("sha256")
		.update(normalize(input.worktreePath))
		.digest("hex")
		.slice(0, 16);
	return join(
		input.agentDir,
		"extensions",
		EXTENSION_NAME,
		"worktree-index",
		`${hash}.json`,
	);
}

export async function saveWorktreeProjectIndex(input: {
	fs: PlannerFs;
	agentDir: string;
	record: WorktreeProjectIndexRecord;
}): Promise<void> {
	await writeJson(
		input.fs,
		createWorktreeProjectIndexPath({
			agentDir: input.agentDir,
			worktreePath: input.record.worktreePath,
		}),
		input.record,
	);
}

export async function bindWorktreeRootSession(input: {
	fs: PlannerFs;
	agentDir: string;
	worktreePath: string;
	projectRoot: string;
	projectId: string;
	planId: string;
	createdFromSessionFile?: string | null;
	lastRootSessionFile?: string | null;
}): Promise<WorktreeProjectIndexRecord> {
	const existing = await readWorktreeProjectIndexIfExists(input);
	const record: WorktreeProjectIndexRecord = {
		schemaVersion: SCHEMA_VERSION,
		worktreePath: input.worktreePath,
		projectRoot: input.projectRoot,
		projectId: input.projectId,
		planId: input.planId,
		createdFromSessionFile:
			existing?.createdFromSessionFile ??
			input.createdFromSessionFile ??
			input.lastRootSessionFile ??
			null,
		lastRootSessionFile:
			input.lastRootSessionFile ??
			existing?.lastRootSessionFile ??
			input.createdFromSessionFile ??
			null,
	};
	await saveWorktreeProjectIndex({
		fs: input.fs,
		agentDir: input.agentDir,
		record,
	});
	return record;
}

export async function readWorktreeProjectIndexIfExists(input: {
	fs: PlannerFs;
	agentDir: string;
	worktreePath: string;
}): Promise<WorktreeProjectIndexRecord | null> {
	const record = await readJsonIfExists<WorktreeProjectIndexRecord>(
		input.fs,
		createWorktreeProjectIndexPath(input),
	);
	return record;
}
