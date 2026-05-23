import { describe, expect, it } from "vitest";
import {
	createPlanStoragePaths,
	createProjectStoragePaths,
} from "../storage/paths";
import { MockPlannerFs } from "../test/mock-fs";
import {
	initializeMemoryFiles,
	markMemoryDirty,
	upsertFileEntries,
	upsertRelationEntries,
	upsertSymbolEntries,
	writeProjectPatterns,
} from "./manager";
import { retrieveMemoryContext } from "./retrieval";
import type {
	MemoryFileEntry,
	MemoryRelationEntry,
	MemorySymbolEntry,
} from "./schema";

describe("memory retrieval", () => {
	it("returns bounded chunks with cursors instead of dumping full memory", async () => {
		const fs = new MockPlannerFs();
		const paths = await initializeTestMemory(fs);
		await upsertFileEntries(fs, paths, [
			fileEntry("src/a.ts"),
			fileEntry("src/b.ts"),
			fileEntry("src/c.ts"),
		]);
		await upsertSymbolEntries(fs, paths, [
			symbolEntry("sym_a", "src/a.ts", "none"),
			symbolEntry("sym_b", "src/b.ts", "none"),
			symbolEntry("sym_c", "src/c.ts", "none"),
		]);

		const first = await retrieveMemoryContext({
			fs,
			paths,
			limits: { files: 2, symbols: 2, relations: 2 },
		});
		const second = await retrieveMemoryContext({
			fs,
			paths,
			cursor: {
				files: first.files.nextCursor ?? undefined,
				symbols: first.symbols.nextCursor ?? undefined,
			},
			limits: { files: 2, symbols: 2 },
		});

		expect(first.files.entries.map((entry) => entry.path)).toEqual([
			"src/a.ts",
			"src/b.ts",
		]);
		expect(first.files.nextCursor).toBe(2);
		expect(first.symbols.entries.map((entry) => entry.id)).toEqual([
			"sym_a",
			"sym_b",
		]);
		expect(first.symbols.nextCursor).toBe(2);
		expect(second.files.entries.map((entry) => entry.path)).toEqual([
			"src/c.ts",
		]);
		expect(second.files.nextCursor).toBeNull();
		expect(second.symbols.entries.map((entry) => entry.id)).toEqual(["sym_c"]);
		expect(second.symbols.nextCursor).toBeNull();
	});

	it("searches files, symbols, and relations by compact textual fields", async () => {
		const fs = new MockPlannerFs();
		const paths = await initializeTestMemory(fs);
		await upsertFileEntries(fs, paths, [
			fileEntry("src/config.ts", "Configuration parser."),
			fileEntry("src/server.ts", "HTTP server."),
		]);
		await upsertSymbolEntries(fs, paths, [
			symbolEntry("sym_parse_config", "src/config.ts", "reads"),
			symbolEntry("sym_start_server", "src/server.ts", "writes"),
		]);
		await upsertRelationEntries(fs, paths, [
			relationEntry(
				"rel_config_server",
				"sym_start_server",
				"sym_parse_config",
			),
		]);

		const result = await retrieveMemoryContext({
			fs,
			paths,
			query: "config",
			limits: { files: 10, symbols: 10, relations: 10 },
		});

		expect(result.files.entries.map((entry) => entry.path)).toEqual([
			"src/config.ts",
		]);
		expect(result.symbols.entries.map((entry) => entry.id)).toEqual([
			"sym_parse_config",
		]);
		expect(result.relations.entries.map((entry) => entry.id)).toEqual([
			"rel_config_server",
		]);
	});

	it("applies structured filters and dirty-only retrieval", async () => {
		const fs = new MockPlannerFs();
		const paths = await initializeTestMemory(fs);
		await upsertFileEntries(fs, paths, [
			fileEntry("src/config.ts"),
			fileEntry("src/server.ts"),
		]);
		await upsertSymbolEntries(fs, paths, [
			symbolEntry("sym_parse_config", "src/config.ts", "reads"),
			symbolEntry("sym_start_server", "src/server.ts", "writes"),
		]);
		await markMemoryDirty(fs, paths, {
			files: ["src/server.ts"],
			reason: "file_hash_changed",
			detectedAt: "2026-05-23T10:00:00.000Z",
		});

		const result = await retrieveMemoryContext({
			fs,
			paths,
			filters: {
				dirtyOnly: true,
				globalState: ["writes"],
				symbolKinds: ["function"],
				verificationStatus: ["verified"],
			},
			includeDirtyState: true,
			limits: { files: 10, symbols: 10 },
		});

		expect(result.files.entries.map((entry) => entry.path)).toEqual([
			"src/server.ts",
		]);
		expect(result.symbols.entries.map((entry) => entry.id)).toEqual([
			"sym_start_server",
		]);
		expect(result.dirty).toEqual({
			files: {
				"src/server.ts": {
					reason: "file_hash_changed",
					detectedAt: "2026-05-23T10:00:00.000Z",
				},
			},
		});
	});

	it("optionally includes project patterns without requiring full memory output", async () => {
		const fs = new MockPlannerFs();
		const paths = await initializeTestMemory(fs);
		await writeProjectPatterns(fs, paths, "# Patterns\n\nUse small modules.\n");

		const result = await retrieveMemoryContext({
			fs,
			paths,
			includeProjectPatterns: true,
			limits: { files: 1, symbols: 1, relations: 1 },
		});

		expect(result.projectPatterns).toBe("# Patterns\n\nUse small modules.\n");
		expect(result.files.entries).toEqual([]);
		expect(result.symbols.entries).toEqual([]);
		expect(result.relations.entries).toEqual([]);
	});

	it("clamps weird limits and cursors to bounded pages", async () => {
		const fs = new MockPlannerFs();
		const paths = await initializeTestMemory(fs);
		await upsertFileEntries(fs, paths, [
			fileEntry("src/a.ts"),
			fileEntry("src/b.ts"),
		]);

		const negative = await retrieveMemoryContext({
			fs,
			paths,
			cursor: { files: -10 },
			limits: { files: 0 },
		});
		const tooLarge = await retrieveMemoryContext({
			fs,
			paths,
			cursor: { files: 20 },
			limits: { files: 1000 },
		});

		expect(negative.files).toMatchObject({
			start: 0,
			limit: 1,
			nextCursor: 1,
		});
		expect(negative.files.entries.map((entry) => entry.path)).toEqual([
			"src/a.ts",
		]);
		expect(tooLarge.files).toMatchObject({
			entries: [],
			start: 20,
			limit: 100,
			nextCursor: null,
		});
	});

	it("filters by directory path, language, relation kind, and case-insensitive query", async () => {
		const fs = new MockPlannerFs();
		const paths = await initializeTestMemory(fs);
		await upsertFileEntries(fs, paths, [
			fileEntry("src/config/index.ts", "Configuration parser."),
			fileEntry("tests/config.test.ts", "CONFIG tests."),
			fileEntry("src/server.go", "Server."),
		]);
		await upsertSymbolEntries(fs, paths, [
			symbolEntry("sym_parse_config", "src/config/index.ts", "reads"),
			{
				...symbolEntry("sym_go_server", "src/server.go", "none"),
				language: "go",
			},
		]);
		await upsertRelationEntries(fs, paths, [
			relationEntry("rel_tests_config", "sym_test", "sym_parse_config"),
			{
				...relationEntry("rel_calls_config", "sym_server", "sym_parse_config"),
				kind: "calls",
			},
		]);

		const result = await retrieveMemoryContext({
			fs,
			paths,
			query: "CONFIG",
			filters: {
				paths: ["src/config"],
				languages: ["ts"],
				relationKinds: ["calls"],
			},
			limits: { files: 10, symbols: 10, relations: 10 },
		});

		expect(result.files.entries.map((entry) => entry.path)).toEqual([
			"src/config/index.ts",
		]);
		expect(result.symbols.entries.map((entry) => entry.id)).toEqual([
			"sym_parse_config",
		]);
		expect(result.relations.entries).toEqual([]);
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

function fileEntry(
	path: string,
	summary = `${path} summary.`,
): MemoryFileEntry {
	return {
		path,
		kind: path.endsWith(".test.ts") ? "test" : "source",
		language: "ts",
		hash: `hash:${path}`,
		status: "indexed",
		summary,
	};
}

function symbolEntry(
	id: string,
	path: string,
	globalState: MemorySymbolEntry["effects"]["globalState"],
): MemorySymbolEntry {
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
			reads: globalState === "reads" ? ["process.env.CONFIG_PATH"] : [],
			writes: globalState === "writes" ? ["global.cache"] : [],
			io: globalState === "writes" ? ["filesystem:write"] : [],
			globalState,
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
): MemoryRelationEntry {
	return {
		id,
		from,
		to,
		kind: "configures",
		evidencePath: "src/server.ts",
		evidenceSearchText: "parseConfig(",
	};
}
