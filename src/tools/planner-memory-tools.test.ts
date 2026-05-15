import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ProjectMemoryStore } from "../memory/store";
import { createSettingsPaths } from "../settings/paths";
import { MemoryFs } from "../test/memory-fs";
import { createPlannerMemoryTools } from "./planner-memory-tools";

const paths = createSettingsPaths({
	agentDir: "/agent",
	cwd: "/repo",
	extensionName: "pi-planner",
});

function context(): ExtensionContext {
	return {
		cwd: "/repo",
	} as unknown as ExtensionContext;
}

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

function toolsByName(store: ProjectMemoryStore) {
	return new Map(
		createPlannerMemoryTools(() => store).map((tool) => [tool.name, tool]),
	);
}

describe("createPlannerMemoryTools", () => {
	it("registers provider-safe memory tool names", () => {
		const { store } = createStore();
		const tools = createPlannerMemoryTools(() => store);

		expect(tools.map((tool) => tool.name)).toEqual([
			"planner_memory_status",
			"planner_memory_upsert_files",
			"planner_memory_upsert_symbols",
			"planner_memory_upsert_relations",
			"planner_memory_search_symbols",
			"planner_memory_get_symbols_by_file",
			"planner_memory_get_symbol_context",
			"planner_memory_get_relations",
			"planner_memory_delete_symbol",
			"planner_memory_delete_relation",
			"planner_memory_mark_dirty",
			"planner_memory_get_dirty",
			"planner_memory_clear_dirty",
			"planner_memory_verify_symbol",
			"planner_memory_verify_file",
		]);
		expect(tools[0].promptGuidelines?.length).toBeGreaterThan(0);
	});

	it("upserts files and reports memory status", async () => {
		const { store } = createStore();
		const tools = toolsByName(store);
		const upsertFiles = tools.get("planner_memory_upsert_files");
		const status = tools.get("planner_memory_status");
		if (!upsertFiles || !status) throw new Error("Missing memory tool.");

		await upsertFiles.execute(
			"call-1",
			{
				entries: [
					{
						filePath: "src/config.ts",
						kind: "source",
						language: "ts",
						hash: null,
						sizeBytes: null,
						indexedAt: null,
						indexStatus: "pending",
						summary: null,
					},
				],
			},
			undefined,
			undefined,
			context(),
		);
		const result = await status.execute(
			"call-2",
			{},
			undefined,
			undefined,
			context(),
		);

		expect(result.details).toMatchObject({
			manifest: {
				counts: {
					files: 1,
				},
			},
		});
	});

	it("upserts symbols, searches them, and loads symbol context", async () => {
		const { store } = createStore();
		const tools = toolsByName(store);
		const upsertSymbols = tools.get("planner_memory_upsert_symbols");
		const upsertRelations = tools.get("planner_memory_upsert_relations");
		const searchSymbols = tools.get("planner_memory_search_symbols");
		const symbolContext = tools.get("planner_memory_get_symbol_context");
		if (
			!upsertSymbols ||
			!upsertRelations ||
			!searchSymbols ||
			!symbolContext
		) {
			throw new Error("Missing memory tool.");
		}

		await upsertSymbols.execute(
			"call-1",
			{
				entries: [
					{
						id: "sym_parse",
						language: "ts",
						kind: "function",
						name: "parseConfig",
						qualifiedName: "parseConfig",
						filePath: "src/config.ts",
						signature: "function parseConfig(input: string): Config",
						summary: "Parses config text.",
						visibility: "public",
						stability: "stable",
						anchors: {
							searchText: "function parseConfig(input: string): Config",
						},
						confidence: 0.9,
					},
					{
						id: "sym_test",
						language: "ts",
						kind: "test",
						name: "parseConfig test",
						qualifiedName: "parseConfig.test",
						filePath: "src/config.test.ts",
						signature: "it('parses config')",
						summary: "Covers config parsing.",
						visibility: "test_only",
						stability: "stable",
						anchors: {
							searchText: "parseConfig(",
						},
						confidence: 0.8,
					},
				],
			},
			undefined,
			undefined,
			context(),
		);
		await upsertRelations.execute(
			"call-2",
			{
				entries: [
					{
						id: "rel_test",
						fromSymbolId: "sym_test",
						toSymbolId: "sym_parse",
						kind: "tests",
						summary: "Test covers parser.",
						evidenceFilePath: "src/config.test.ts",
						evidenceSearchText: "parseConfig(",
						confidence: 0.8,
					},
				],
			},
			undefined,
			undefined,
			context(),
		);

		const search = await searchSymbols.execute(
			"call-3",
			{ name: "parseConfig" },
			undefined,
			undefined,
			context(),
		);
		const contextResult = await symbolContext.execute(
			"call-4",
			{ symbolId: "sym_parse" },
			undefined,
			undefined,
			context(),
		);

		expect(search.details).toMatchObject({
			symbols: [expect.objectContaining({ id: "sym_parse" })],
		});
		expect(contextResult.details).toMatchObject({
			context: {
				symbol: { id: "sym_parse" },
				relations: [expect.objectContaining({ id: "rel_test" })],
				relatedSymbols: [expect.objectContaining({ id: "sym_test" })],
			},
		});
	});

	it("marks, reads, and clears dirty files", async () => {
		const { store } = createStore();
		const tools = toolsByName(store);
		const markDirty = tools.get("planner_memory_mark_dirty");
		const getDirty = tools.get("planner_memory_get_dirty");
		const clearDirty = tools.get("planner_memory_clear_dirty");
		if (!markDirty || !getDirty || !clearDirty) {
			throw new Error("Missing memory tool.");
		}

		await markDirty.execute(
			"call-1",
			{ filePaths: ["src/config.ts"], reason: "edit result" },
			undefined,
			undefined,
			context(),
		);
		const dirty = await getDirty.execute(
			"call-2",
			{},
			undefined,
			undefined,
			context(),
		);
		await clearDirty.execute(
			"call-3",
			{ filePaths: ["src/config.ts"] },
			undefined,
			undefined,
			context(),
		);

		expect(dirty.details).toMatchObject({
			dirty: {
				files: {
					"src/config.ts": {
						reason: "edit result",
					},
				},
			},
		});
		expect(store.getDirtyFiles().files).toEqual({});
	});

	it("verifies and deletes stale symbols through tools", async () => {
		const { fs, store } = createStore();
		fs.setFile(
			"/repo/src/config.ts",
			"export function parseConfig(input: string): Config { return {} as Config; }\n",
		);
		store.upsertSymbols([
			{
				id: "sym_parse",
				language: "ts",
				kind: "function",
				name: "parseConfig",
				qualifiedName: "parseConfig",
				filePath: "src/config.ts",
				signature: "function parseConfig(input: string): Config",
				summary: "Parses config text.",
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
			},
		]);
		const tools = toolsByName(store);
		const verify = tools.get("planner_memory_verify_symbol");
		const deleteSymbol = tools.get("planner_memory_delete_symbol");
		if (!verify || !deleteSymbol) throw new Error("Missing memory tool.");

		const verified = await verify.execute(
			"call-1",
			{ symbolId: "sym_parse" },
			undefined,
			undefined,
			context(),
		);
		await deleteSymbol.execute(
			"call-2",
			{ symbolId: "sym_parse", reason: "no longer needed" },
			undefined,
			undefined,
			context(),
		);

		expect(verified.details).toMatchObject({
			result: {
				found: true,
			},
		});
		expect(store.getSymbol("sym_parse")).toBeNull();
	});

	it("resolves the store with the current cwd", async () => {
		const { store } = createStore();
		const getStore = vi.fn(() => store);
		const tool = createPlannerMemoryTools(getStore)[0];

		await tool.execute("call-1", {}, undefined, undefined, context());

		expect(getStore).toHaveBeenCalledWith("/repo");
	});
});
