import { describe, expect, it } from "vitest";
import {
	createPlanStoragePaths,
	createProjectStoragePaths,
} from "../storage/paths";
import { MockPlannerFs } from "../test/mock-fs";
import { initializeMemoryFiles, readRelationIndex } from "./manager";
import type {
	MemoryFileEntry,
	MemoryRelationEntry,
	MemorySymbolEntry,
} from "./schema";
import {
	validateMemoryBatchAgainstIndexes,
	writeMemoryBatch,
	writeMemoryBatchWithReferences,
} from "./write-api";

describe("memory write api", () => {
	it("accepts valid batch entries and rejects malformed model output", async () => {
		const fs = new MockPlannerFs();
		const paths = await initializeTestMemory(fs);
		const file = fileEntry("src/config.ts");
		const symbol = symbolEntry("sym_parse_config", "src/config.ts");

		const result = await writeMemoryBatch({
			fs,
			paths,
			files: [file, { path: "/abs/config.ts", kind: "source" }],
			symbols: [symbol, { id: "sym_bad", path: "../bad.ts" }],
			relations: [{ id: "rel_bad", from: "a", to: 1 }],
		});

		expect(result.accepted.files).toEqual([file]);
		expect(result.accepted.symbols).toEqual([symbol]);
		expect(result.accepted.relations).toEqual([]);
		expect(result.rejected).toEqual([
			{
				kind: "file",
				index: 1,
				id: "/abs/config.ts",
				reasons: expect.arrayContaining([
					"hash must be a non-empty string.",
					"status must be a non-empty string.",
					"summary must be a non-empty string.",
					"path must be relative, not absolute.",
				]),
			},
			{
				kind: "symbol",
				index: 1,
				id: "sym_bad",
				reasons: expect.arrayContaining([
					"language must be a non-empty string.",
					"kind must be a non-empty string.",
					"path must not contain parent traversal.",
				]),
			},
			{
				kind: "relation",
				index: 0,
				id: "rel_bad",
				reasons: expect.arrayContaining(["to must be a string or null."]),
			},
		]);
		expect(result.totals).toEqual({ input: 5, accepted: 2, rejected: 3 });
	});

	it("validates relation references against existing and incoming entries before writing", async () => {
		const fs = new MockPlannerFs();
		const paths = await initializeTestMemory(fs);
		const file = fileEntry("src/config.test.ts");
		const tested = symbolEntry("sym_parse_config", "src/config.ts");
		const test = symbolEntry("sym_parse_config_tests", "src/config.test.ts");
		const validRelation = relationEntry(
			"rel_tests_config",
			"sym_parse_config_tests",
			"sym_parse_config",
			"src/config.test.ts",
		);
		const invalidRelation = relationEntry(
			"rel_missing",
			"sym_missing",
			"sym_parse_config",
			"src/missing.test.ts",
		);

		const result = await writeMemoryBatchWithReferences({
			fs,
			paths,
			files: [file],
			symbols: [tested, test],
			relations: [validRelation, invalidRelation],
		});

		expect(result.accepted.relations).toEqual([validRelation]);
		expect(result.rejected).toEqual([
			{
				kind: "relation",
				index: 1,
				id: "rel_missing",
				reasons: [
					"Relation from symbol does not exist: sym_missing",
					"Relation evidence file does not exist in memory file index: src/missing.test.ts",
				],
			},
		]);
		expect(await readRelationIndex(fs, paths)).toEqual([validRelation]);
	});

	it("does not leave invalid relation entries behind when reference validation fails", async () => {
		const fs = new MockPlannerFs();
		const paths = await initializeTestMemory(fs);

		await writeMemoryBatchWithReferences({
			fs,
			paths,
			relations: [
				relationEntry(
					"rel_orphan",
					"sym_missing_from",
					"sym_missing_to",
					"src/missing.ts",
				),
			],
		});

		expect(await readRelationIndex(fs, paths)).toEqual([]);
	});

	it("keeps compatibility alias for reference-validated writes", async () => {
		const fs = new MockPlannerFs();
		const paths = await initializeTestMemory(fs);

		const result = await validateMemoryBatchAgainstIndexes({
			fs,
			paths,
			files: [fileEntry("src/config.ts")],
			symbols: [symbolEntry("sym_parse_config", "src/config.ts")],
			relations: [
				relationEntry(
					"rel_self",
					"sym_parse_config",
					"sym_parse_config",
					"src/config.ts",
				),
			],
		});

		expect(result.totals).toEqual({ input: 3, accepted: 3, rejected: 0 });
	});
});

async function initializeTestMemory(fs: MockPlannerFs) {
	const projectPaths = createProjectStoragePaths({
		agentDir: "/agent",
		projectRoot: "/repo/app",
	});
	const planPaths = createPlanStoragePaths(projectPaths, "plan-a");
	return await initializeMemoryFiles(fs, planPaths);
}

function fileEntry(path: string): MemoryFileEntry {
	return {
		path,
		kind: path.endsWith(".test.ts") ? "test" : "source",
		language: "ts",
		hash: `hash:${path}`,
		status: "indexed",
		summary: `${path} summary.`,
	};
}

function symbolEntry(id: string, path: string): MemorySymbolEntry {
	const name = id.replace(/^sym_/, "");
	return {
		id,
		path,
		language: "ts",
		kind: "function",
		name,
		qualifiedName: name,
		signature: `function ${name}(): void`,
		summary: `${name} summary.`,
		visibility: "public",
		effects: {
			reads: [],
			writes: [],
			io: [],
			globalState: "unknown",
		},
		anchor: {
			searchText: `function ${name}`,
		},
		verification: {
			fileHash: `hash:${path}`,
			status: "verified",
		},
	};
}

function relationEntry(
	id: string,
	from: string,
	to: string | null,
	evidencePath: string,
): MemoryRelationEntry {
	return {
		id,
		from,
		to,
		kind: "tests",
		evidencePath,
		evidenceSearchText: "parseConfig(",
	};
}
