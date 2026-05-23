import { describe, expect, it } from "vitest";
import {
	createPlanStoragePaths,
	createProjectStoragePaths,
} from "../storage/paths";
import { MockPlannerFs } from "../test/mock-fs";
import { type PlannerJsonlError, readJsonl, writeJsonl } from "./jsonl";
import {
	clearMemoryDirty,
	computeMemoryCheckpoint,
	initializeMemoryFiles,
	markMemoryDirty,
	readFileIndex,
	readMemoryDirtyState,
	readProjectPatterns,
	readRelationIndex,
	readSymbolIndex,
	removeFileEntries,
	removeRelationEntries,
	removeSymbolEntries,
	replaceFileIndex,
	upsertFileEntries,
	upsertRelationEntries,
	upsertSymbolEntries,
	verifyMemoryCheckpoint,
	writeMemoryCheckpoint,
	writeProjectPatterns,
} from "./manager";
import { createMemoryStoragePaths } from "./paths";
import type {
	MemoryFileEntry,
	MemoryRelationEntry,
	MemorySymbolEntry,
} from "./schema";

describe("memory jsonl helpers", () => {
	it("reads and writes newline-delimited json atomically", async () => {
		const fs = new MockPlannerFs();

		await writeJsonl(fs, "/memory/index.jsonl", [{ id: "a" }, { id: "b" }]);

		await expect(
			readJsonl(
				fs,
				"/memory/index.jsonl",
				(value): value is { id: string } =>
					typeof value === "object" &&
					value !== null &&
					"id" in value &&
					typeof value.id === "string",
			),
		).resolves.toEqual([{ id: "a" }, { id: "b" }]);
		expect(fs.snapshot()["/memory/index.jsonl"]).toBe(
			'{"id":"a"}\n{"id":"b"}\n',
		);
		expect(fs.atomicWrites).toEqual(["/memory/index.jsonl"]);
	});

	it("reports invalid jsonl line and invalid entry shape", async () => {
		const fs = new MockPlannerFs();
		await fs.writeText("/memory/bad-json.jsonl", "{");
		await fs.writeText("/memory/bad-shape.jsonl", '{"id":1}\n');

		await expect(
			readJsonl(
				fs,
				"/memory/bad-json.jsonl",
				(value): value is { id: string } => typeof value === "object",
			),
		).rejects.toMatchObject({
			name: "PlannerJsonlError",
			line: 1,
		} satisfies Partial<PlannerJsonlError>);

		await expect(
			readJsonl(
				fs,
				"/memory/bad-shape.jsonl",
				(value): value is { id: string } =>
					typeof value === "object" &&
					value !== null &&
					"id" in value &&
					typeof value.id === "string",
			),
		).rejects.toMatchObject({
			name: "PlannerJsonlError",
			line: 1,
		} satisfies Partial<PlannerJsonlError>);
	});
});

describe("memory manager", () => {
	it("initializes memory files without overwriting existing content", async () => {
		const fs = new MockPlannerFs();
		const planPaths = createTestPlanPaths();
		const paths = createMemoryStoragePaths(planPaths);
		await fs.writeText(paths.projectPatternsMd, "existing patterns");

		await initializeMemoryFiles(fs, planPaths);

		expect(await fs.exists(paths.filesDir)).toBe(true);
		expect(await fs.exists(paths.symbolsDir)).toBe(true);
		expect(await fs.exists(paths.relationsDir)).toBe(true);
		expect(await readProjectPatterns(fs, paths)).toBe("existing patterns");
		expect(fs.snapshot()[paths.filesIndexJsonl]).toBe("");
		expect(fs.snapshot()[paths.symbolsIndexJsonl]).toBe("");
		expect(fs.snapshot()[paths.relationsIndexJsonl]).toBe("");
		expect(await readMemoryDirtyState(fs, paths)).toEqual({ files: {} });
		expect(await verifyMemoryCheckpoint(fs, paths)).toMatchObject({
			valid: true,
			mismatches: [],
		});
	});

	it("writes and reads project patterns", async () => {
		const fs = new MockPlannerFs();
		const paths = await initializeTestMemory(fs);

		await writeProjectPatterns(fs, paths, "# Patterns\n\nUse pure helpers.\n");

		await expect(readProjectPatterns(fs, paths)).resolves.toBe(
			"# Patterns\n\nUse pure helpers.\n",
		);
	});

	it("replaces, upserts, and removes file entries by path", async () => {
		const fs = new MockPlannerFs();
		const paths = await initializeTestMemory(fs);
		const config = fileEntry("src/config.ts", "hash-a", "Config parser.");
		const configUpdated = fileEntry(
			"src/config.ts",
			"hash-b",
			"Updated config parser.",
		);
		const test = fileEntry("src/config.test.ts", "hash-test", "Config tests.");

		await replaceFileIndex(fs, paths, [config]);
		expect(await upsertFileEntries(fs, paths, [configUpdated, test])).toEqual([
			configUpdated,
			test,
		]);
		expect(await removeFileEntries(fs, paths, ["src/config.ts"])).toEqual([
			test,
		]);
		expect(await readFileIndex(fs, paths)).toEqual([test]);
	});

	it("upserts and removes symbol entries by id with effects intact", async () => {
		const fs = new MockPlannerFs();
		const paths = await initializeTestMemory(fs);
		const parseConfig = symbolEntry("sym_parse_config", "parseConfig", "none");
		const parseConfigWithIo = symbolEntry(
			"sym_parse_config",
			"parseConfig",
			"reads",
		);
		const loadConfig = symbolEntry("sym_load_config", "loadConfig", "writes");

		expect(
			await upsertSymbolEntries(fs, paths, [parseConfig, loadConfig]),
		).toEqual([parseConfig, loadConfig]);
		expect(await upsertSymbolEntries(fs, paths, [parseConfigWithIo])).toEqual([
			parseConfigWithIo,
			loadConfig,
		]);
		expect(await removeSymbolEntries(fs, paths, ["sym_load_config"])).toEqual([
			parseConfigWithIo,
		]);
		expect(await readSymbolIndex(fs, paths)).toEqual([parseConfigWithIo]);
	});

	it("upserts and removes relation entries by id", async () => {
		const fs = new MockPlannerFs();
		const paths = await initializeTestMemory(fs);
		const relation = relationEntry("rel_tests_config", "tests");
		const updated = relationEntry("rel_tests_config", "calls");

		expect(await upsertRelationEntries(fs, paths, [relation])).toEqual([
			relation,
		]);
		expect(await upsertRelationEntries(fs, paths, [updated])).toEqual([
			updated,
		]);
		expect(
			await removeRelationEntries(fs, paths, ["rel_tests_config"]),
		).toEqual([]);
		expect(await readRelationIndex(fs, paths)).toEqual([]);
	});

	it("rejects invalid entry shapes before writing indexes", async () => {
		const fs = new MockPlannerFs();
		const paths = await initializeTestMemory(fs);

		await expect(
			upsertFileEntries(fs, paths, [
				{ path: "src/config.ts" } as unknown as MemoryFileEntry,
			]),
		).rejects.toThrow("Invalid file index entry.");
		await expect(
			upsertSymbolEntries(fs, paths, [
				{ id: "sym_bad" } as unknown as MemorySymbolEntry,
			]),
		).rejects.toThrow("Invalid symbol index entry.");
		await expect(
			upsertRelationEntries(fs, paths, [
				{ id: "rel_bad" } as unknown as MemoryRelationEntry,
			]),
		).rejects.toThrow("Invalid relation index entry.");
	});

	it("marks and clears dirty files without blocking unrelated files", async () => {
		const fs = new MockPlannerFs();
		const paths = await initializeTestMemory(fs);

		await markMemoryDirty(fs, paths, {
			files: ["src/config.ts", "src/env.ts"],
			reason: "file_hash_changed",
			detectedAt: "2026-05-23T09:00:00.000Z",
		});
		const updated = await markMemoryDirty(fs, paths, {
			files: ["src/config.ts"],
			reason: "verification_failed",
			detectedAt: "2026-05-23T09:05:00.000Z",
		});

		expect(updated).toEqual({
			files: {
				"src/config.ts": {
					reason: "verification_failed",
					detectedAt: "2026-05-23T09:05:00.000Z",
				},
				"src/env.ts": {
					reason: "file_hash_changed",
					detectedAt: "2026-05-23T09:00:00.000Z",
				},
			},
		});
		expect(await clearMemoryDirty(fs, paths, ["src/config.ts"])).toEqual({
			files: {
				"src/env.ts": {
					reason: "file_hash_changed",
					detectedAt: "2026-05-23T09:00:00.000Z",
				},
			},
		});
	});

	it("writes and verifies memory checkpoints from index file hashes", async () => {
		const fs = new MockPlannerFs();
		const paths = await initializeTestMemory(fs);

		await upsertFileEntries(fs, paths, [
			fileEntry("src/config.ts", "hash-a", "Config parser."),
		]);
		await upsertSymbolEntries(fs, paths, [
			symbolEntry("sym_parse_config", "parseConfig", "none"),
		]);
		const checkpoint = await writeMemoryCheckpoint(fs, paths, "abc123");

		expect(checkpoint.commit).toBe("abc123");
		expect(await verifyMemoryCheckpoint(fs, paths)).toMatchObject({
			valid: true,
			mismatches: [],
		});

		await upsertRelationEntries(fs, paths, [
			relationEntry("rel_tests_config", "tests"),
		]);

		expect(await verifyMemoryCheckpoint(fs, paths)).toMatchObject({
			valid: false,
			expected: checkpoint,
			mismatches: ["relationsIndexHash"],
		});
		expect(
			await computeMemoryCheckpoint(fs, paths, "abc123"),
		).not.toMatchObject({
			relationsIndexHash: checkpoint.relationsIndexHash,
		});
	});
});

async function initializeTestMemory(fs: MockPlannerFs) {
	const planPaths = createTestPlanPaths();
	return await initializeMemoryFiles(fs, planPaths);
}

function createTestPlanPaths() {
	const projectPaths = createProjectStoragePaths({
		agentDir: "/agent",
		projectRoot: "/repo/app",
	});
	return createPlanStoragePaths(projectPaths, "plan-a");
}

function fileEntry(
	path: string,
	hash: string,
	summary: string,
): MemoryFileEntry {
	return {
		path,
		kind: path.endsWith(".test.ts") ? "test" : "source",
		language: "ts",
		hash,
		status: "indexed",
		summary,
	};
}

function symbolEntry(
	id: string,
	name: string,
	globalState: MemorySymbolEntry["effects"]["globalState"],
): MemorySymbolEntry {
	return {
		id,
		path: "src/config.ts",
		language: "ts",
		kind: "function",
		name,
		qualifiedName: name,
		signature: `function ${name}(input: string): Config`,
		summary: `${name} summary.`,
		visibility: "public",
		effects: {
			reads: globalState === "reads" ? ["process.env.CONFIG_PATH"] : [],
			writes: globalState === "writes" ? ["global.cache"] : [],
			io: globalState === "writes" ? ["filesystem:write"] : [],
			globalState,
		},
		anchor: {
			searchText: `function ${name}`,
		},
		verification: {
			fileHash: "hash-a",
			status: "verified",
		},
	};
}

function relationEntry(
	id: string,
	kind: MemoryRelationEntry["kind"],
): MemoryRelationEntry {
	return {
		id,
		from: "sym_parse_config_tests",
		to: "sym_parse_config",
		kind,
		evidencePath: "src/config.test.ts",
		evidenceSearchText: "parseConfig(",
	};
}
