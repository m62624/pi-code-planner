import { describe, expect, it } from "vitest";
import { createSettingsPaths } from "../settings/paths";
import { MemoryFs } from "../test/memory-fs";
import { getProjectMemoryPaths } from "./paths";
import type { FileEntry, SymbolEntry, SymbolRelation } from "./schema";
import { ProjectMemoryStore } from "./store";

const paths = createSettingsPaths({
	agentDir: "/agent",
	cwd: "/repo",
	extensionName: "pi-planner",
});

function createStore() {
	const fs = new MemoryFs();
	const store = new ProjectMemoryStore({
		paths,
		fs,
		projectPath: "/repo",
		now: () => "2026-05-15T00:00:00.000Z",
	});
	return { fs, store };
}

function fileEntry(filePath: string): FileEntry {
	return {
		filePath,
		kind: "source",
		language: "ts",
		hash: null,
		sizeBytes: null,
		indexedAt: null,
		indexStatus: "pending",
		summary: null,
		updatedAt: "",
	};
}

function symbolEntry(input: Partial<SymbolEntry> = {}): SymbolEntry {
	return {
		id: "sym_parse",
		language: "ts",
		kind: "function",
		name: "parseConfig",
		qualifiedName: "parseConfig",
		filePath: "src/config.ts",
		signature: "function parseConfig(input: string): Config",
		summary: "Parses raw config text.",
		visibility: "public",
		stability: "stable",
		anchors: {
			searchText: "function parseConfig(input: string): Config",
			normalizedSignature: "",
		},
		evidence: {
			fileHash: null,
			searchTextHash: "",
			verifiedAt: null,
			verificationStatus: "unverified",
		},
		confidence: 0.9,
		updatedAt: "",
		...input,
	};
}

function relationEntry(input: Partial<SymbolRelation> = {}): SymbolRelation {
	return {
		id: "rel_test",
		fromSymbolId: "sym_test",
		toSymbolId: "sym_parse",
		kind: "tests",
		summary: "Parser tests cover config parsing.",
		evidenceFilePath: "src/config.test.ts",
		evidenceSearchText: "parseConfig(",
		confidence: 0.8,
		updatedAt: "",
		...input,
	};
}

describe("ProjectMemoryStore", () => {
	it("initializes sharded memory files and manifest", () => {
		const { fs, store } = createStore();
		const manifest = store.initialize();
		const memoryPaths = getProjectMemoryPaths({ paths, projectPath: "/repo" });

		expect(manifest).toMatchObject({
			version: 1,
			projectPath: "/repo",
			counts: {
				files: 0,
				symbols: 0,
				relations: 0,
				dirtyFiles: 0,
			},
		});
		expect(fs.exists(memoryPaths.manifest)).toBe(true);
		expect(fs.exists(memoryPaths.filesIndex)).toBe(true);
		expect(fs.exists(memoryPaths.byNameIndex)).toBe(true);
	});

	it("upserts file inventory entries", () => {
		const { store } = createStore();

		store.upsertFiles([fileEntry("src/config.ts")]);
		store.upsertFiles([
			{ ...fileEntry("src/config.ts"), indexStatus: "indexed" },
			fileEntry("src/api.ts"),
		]);

		expect(store.readFiles()).toEqual([
			expect.objectContaining({
				filePath: "src/config.ts",
				indexStatus: "indexed",
			}),
			expect.objectContaining({
				filePath: "src/api.ts",
				indexStatus: "pending",
			}),
		]);
		expect(store.loadManifest().counts.files).toBe(2);
	});

	it("upserts symbols into file shards and searchable indexes", () => {
		const { fs, store } = createStore();

		store.upsertSymbols([symbolEntry()]);

		expect(store.searchSymbols({ name: "parseConfig" })).toEqual([
			expect.objectContaining({
				id: "sym_parse",
				filePath: "src/config.ts",
				evidence: expect.objectContaining({
					searchTextHash: expect.any(String),
					verificationStatus: "unverified",
				}),
			}),
		]);
		expect(store.getSymbolsByFile("src/config.ts")).toHaveLength(1);
		const memoryPaths = getProjectMemoryPaths({ paths, projectPath: "/repo" });
		const shardFiles = fs
			.listFiles()
			.filter((path) => path.startsWith(memoryPaths.symbolsDir));
		expect(shardFiles).toHaveLength(1);
	});

	it("moves symbols between indexes when file path changes", () => {
		const { store } = createStore();

		store.upsertSymbols([symbolEntry()]);
		store.upsertSymbols([symbolEntry({ filePath: "src/new-config.ts" })]);

		expect(store.getSymbolsByFile("src/config.ts")).toEqual([]);
		expect(store.getSymbolsByFile("src/new-config.ts")).toHaveLength(1);
		expect(
			store.readAllSymbols().filter((entry) => entry.id === "sym_parse"),
		).toHaveLength(1);
	});

	it("deletes symbols through tombstones instead of leaving stale indexes", () => {
		const { fs, store } = createStore();
		store.upsertSymbols([symbolEntry()]);

		const deleted = store.deleteSymbol("sym_parse", "hallucinated API");

		expect(deleted).toBe(true);
		expect(store.searchSymbols({ name: "parseConfig" })).toEqual([]);
		const memoryPaths = getProjectMemoryPaths({ paths, projectPath: "/repo" });
		expect(fs.readFile(memoryPaths.deletedSymbols)).toContain(
			"hallucinated API",
		);
	});

	it("upserts relations and returns symbol context", () => {
		const { store } = createStore();
		store.upsertSymbols([
			symbolEntry(),
			symbolEntry({
				id: "sym_test",
				name: "parseConfig rejects invalid input",
				qualifiedName: "parseConfig.test",
				filePath: "src/config.test.ts",
				kind: "test",
			}),
		]);
		store.upsertRelations([relationEntry()]);

		const context = store.getSymbolContext("sym_parse");

		expect(context).toMatchObject({
			symbol: { id: "sym_parse" },
			relations: [expect.objectContaining({ kind: "tests" })],
			relatedSymbols: [expect.objectContaining({ id: "sym_test" })],
		});
		expect(store.loadManifest().counts.relations).toBe(1);
	});

	it("moves relations between shards when evidence file changes", () => {
		const { store } = createStore();

		store.upsertRelations([relationEntry()]);
		store.upsertRelations([
			relationEntry({ evidenceFilePath: "src/new-config.test.ts" }),
		]);

		expect(
			store.readAllRelations().filter((entry) => entry.id === "rel_test"),
		).toHaveLength(1);
		expect(store.getRelations("sym_parse")).toEqual([
			expect.objectContaining({
				evidenceFilePath: "src/new-config.test.ts",
			}),
		]);
	});

	it("tracks dirty files and updates file status", () => {
		const { store } = createStore();
		store.upsertFiles([fileEntry("src/config.ts")]);

		const dirty = store.markFilesDirty(["src/config.ts"], "edit tool result");

		expect(dirty.files["src/config.ts"]).toMatchObject({
			reason: "edit tool result",
		});
		expect(store.readFiles()[0]).toMatchObject({
			filePath: "src/config.ts",
			indexStatus: "dirty",
		});
		expect(store.loadManifest().counts.dirtyFiles).toBe(1);

		store.clearDirtyFiles(["src/config.ts"]);

		expect(store.getDirtyFiles().files).toEqual({});
		expect(store.loadManifest().counts.dirtyFiles).toBe(0);
	});

	it("verifies symbols by searching source files instead of line numbers", () => {
		const { fs, store } = createStore();
		fs.setFile(
			"/repo/src/config.ts",
			"export function parseConfig(input: string): Config { return {} as Config; }\n",
		);
		store.upsertSymbols([
			symbolEntry({
				anchors: {
					searchText: "function parseConfig(input: string): Config",
					normalizedSignature: "",
				},
			}),
		]);

		const result = store.verifySymbol("sym_parse");

		expect(result).toMatchObject({
			found: true,
			symbol: {
				evidence: {
					verificationStatus: "verified",
					verifiedAt: "2026-05-15T00:00:00.000Z",
					fileHash: expect.any(String),
				},
			},
		});
	});

	it("marks verification as missing when search text disappears", () => {
		const { fs, store } = createStore();
		fs.setFile("/repo/src/config.ts", "export const config = {};\n");
		store.upsertSymbols([symbolEntry()]);

		const result = store.verifyFile("src/config.ts");

		expect(result).toEqual([
			expect.objectContaining({
				found: false,
				symbol: expect.objectContaining({
					evidence: expect.objectContaining({
						verificationStatus: "missing",
					}),
				}),
			}),
		]);
	});
});
