import { createHash } from "node:crypto";
import { join } from "node:path";
import type { GitRunner } from "../git/runner";
import type { PlannerFs } from "../storage/fs";
import type { MemoryProjectFileSnapshotEntry } from "./verification";

export interface MemoryProjectSnapshotInput {
	fs: PlannerFs;
	git: GitRunner;
	repoRoot: string;
}

export interface MemoryProjectSnapshot {
	files: MemoryProjectFileSnapshotEntry[];
	missingFiles: string[];
}

export async function createMemoryProjectSnapshot(
	input: MemoryProjectSnapshotInput,
): Promise<MemoryProjectSnapshot> {
	const paths = uniqueSorted(await input.git.listProjectFiles(input));
	const files: MemoryProjectFileSnapshotEntry[] = [];
	const missingFiles: string[] = [];

	for (const path of paths) {
		const content = await readProjectFileIfExists(
			input.fs,
			input.repoRoot,
			path,
		);
		if (content === null) {
			missingFiles.push(path);
			continue;
		}
		files.push({
			path,
			hash: hashText(content),
		});
	}

	return {
		files,
		missingFiles,
	};
}

function uniqueSorted(paths: readonly string[]): string[] {
	return [...new Set(paths.filter((path) => path.trim().length > 0))].sort();
}

async function readProjectFileIfExists(
	fs: PlannerFs,
	repoRoot: string,
	path: string,
): Promise<string | null> {
	try {
		return await fs.readText(join(repoRoot, path));
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return null;
		}
		throw error;
	}
}

function hashText(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
