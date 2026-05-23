import { join } from "node:path";
import type { PlanStoragePaths } from "../storage/paths";

export interface MemoryStoragePaths {
	memoryDir: string;
	projectPatternsMd: string;
	filesDir: string;
	filesIndexJsonl: string;
	symbolsDir: string;
	symbolsIndexJsonl: string;
	relationsDir: string;
	relationsIndexJsonl: string;
	dirtyJson: string;
	checkpointsDir: string;
	latestCheckpointJson: string;
}

export function createMemoryStoragePaths(
	planPaths: PlanStoragePaths,
): MemoryStoragePaths {
	return {
		memoryDir: planPaths.memoryDir,
		projectPatternsMd: join(planPaths.memoryDir, "project_patterns.md"),
		filesDir: join(planPaths.memoryDir, "files"),
		filesIndexJsonl: join(planPaths.memoryDir, "files", "index.jsonl"),
		symbolsDir: join(planPaths.memoryDir, "symbols"),
		symbolsIndexJsonl: join(planPaths.memoryDir, "symbols", "index.jsonl"),
		relationsDir: join(planPaths.memoryDir, "relations"),
		relationsIndexJsonl: join(planPaths.memoryDir, "relations", "index.jsonl"),
		dirtyJson: join(planPaths.memoryDir, "dirty.json"),
		checkpointsDir: join(planPaths.memoryDir, "checkpoints"),
		latestCheckpointJson: join(
			planPaths.memoryDir,
			"checkpoints",
			"latest.json",
		),
	};
}
