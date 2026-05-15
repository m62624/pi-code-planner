import { join } from "node:path";
import { sanitizeId, shortHash } from "../storage/ids";
import type { PlannerStoragePathInput } from "../storage/paths";
import { getProjectStoragePaths } from "../storage/paths";

export interface ProjectMemoryPaths {
	memoryDir: string;
	manifest: string;
	projectSummary: string;
	projectPatterns: string;
	libraryVersions: string;
	openQuestions: string;
	filesDir: string;
	filesIndex: string;
	symbolsDir: string;
	relationsDir: string;
	indexesDir: string;
	byFileIndex: string;
	byNameIndex: string;
	byKindIndex: string;
	symbolShardsIndex: string;
	relationShardsIndex: string;
	deletedDir: string;
	deletedSymbols: string;
	deletedRelations: string;
	dirty: string;
}

export function getProjectMemoryPaths(
	input: PlannerStoragePathInput,
): ProjectMemoryPaths {
	const project = getProjectStoragePaths(input);
	const memoryDir = project.projectMemoryDir;
	const indexesDir = join(memoryDir, "indexes");
	const deletedDir = join(memoryDir, "deleted");
	return {
		memoryDir,
		manifest: join(memoryDir, "manifest.json"),
		projectSummary: join(memoryDir, "project_summary.md"),
		projectPatterns: join(memoryDir, "project_patterns.md"),
		libraryVersions: join(memoryDir, "library_versions.json"),
		openQuestions: join(memoryDir, "open_questions.md"),
		filesDir: join(memoryDir, "files"),
		filesIndex: join(memoryDir, "files", "index.jsonl"),
		symbolsDir: join(memoryDir, "symbols"),
		relationsDir: join(memoryDir, "relations"),
		indexesDir,
		byFileIndex: join(indexesDir, "by_file.json"),
		byNameIndex: join(indexesDir, "by_name.json"),
		byKindIndex: join(indexesDir, "by_kind.json"),
		symbolShardsIndex: join(indexesDir, "symbol_shards.json"),
		relationShardsIndex: join(indexesDir, "relation_shards.json"),
		deletedDir,
		deletedSymbols: join(deletedDir, "symbols.jsonl"),
		deletedRelations: join(deletedDir, "relations.jsonl"),
		dirty: join(memoryDir, "dirty.json"),
	};
}

export function shardNameForFilePath(filePath: string): string {
	const slug = sanitizeId(filePath.replace(/\.[^/.]+$/, ""), "file");
	return `${slug}-${shortHash(filePath, 10)}.jsonl`;
}

export function getSymbolShardPath(
	paths: ProjectMemoryPaths,
	filePath: string,
): string {
	return join(paths.symbolsDir, shardNameForFilePath(filePath));
}

export function getRelationShardPath(
	paths: ProjectMemoryPaths,
	filePath: string,
): string {
	return join(paths.relationsDir, shardNameForFilePath(filePath));
}
