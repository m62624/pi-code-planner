import { createHash } from "node:crypto";
import { join, normalize } from "node:path";
import { EXTENSION_NAME, type SCHEMA_VERSION } from "../constants";
import type { PlannerFs } from "./fs";
import { readJsonIfExists, writeJson } from "./json";

export interface WorktreeProjectIndexRecord {
	schemaVersion: typeof SCHEMA_VERSION;
	worktreePath: string;
	projectRoot: string;
	projectId: string;
	planId: string;
	originalSessionFile?: string | null;
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

export async function readWorktreeProjectIndexIfExists(input: {
	fs: PlannerFs;
	agentDir: string;
	worktreePath: string;
}): Promise<WorktreeProjectIndexRecord | null> {
	return await readJsonIfExists<WorktreeProjectIndexRecord>(
		input.fs,
		createWorktreeProjectIndexPath(input),
	);
}
