import { describe, expect, it } from "vitest";
import {
	createPlanStoragePaths,
	createProjectStoragePaths,
} from "../storage/paths";
import { MockPlannerFs } from "../test/mock-fs";
import {
	initializeMemoryFiles,
	readFileIndex,
	readMemoryDirtyState,
	readRelationIndex,
	readSymbolIndex,
	upsertFileEntries,
	upsertRelationEntries,
	upsertSymbolEntries,
} from "./manager";
import type {
	MemoryFileEntry,
	MemoryRelationEntry,
	MemorySymbolEntry,
} from "./schema";
import { analyzeMemoryFreshness, applyMemoryFreshness } from "./verification";

describe("memory verification", () => {
	it("detects unchanged, changed, missing, and new files without mutating memory", async () => {
		const fs = new MockPlannerFs();
		const paths = await initializeTestMemory(fs);
		await seedMemory(fs, paths);

		const result = await analyzeMemoryFreshness({
			fs,
			paths,
			currentFiles: [
				{ path: "src/config.ts", hash: "hash:changed" },
				{ path: "src/env.ts", hash: "hash:src/env.ts" },
				{ path: "src/new.ts", hash: "hash:new" },
			],
		});

		expect(result).toEqual({
			clean: false,
			unchangedFiles: ["src/env.ts"],
			changedFiles: ["src/config.ts"],
			missingFiles: ["src/server.ts"],
			newFiles: ["src/new.ts"],
			affectedSymbolIds: ["sym_parse_config", "sym_start_server"],
			affectedRelationIds: ["rel_server_config"],
			filesToReindex: ["src/config.ts", "src/new.ts", "src/server.ts"],
		});
		expect(
			(await readFileIndex(fs, paths)).find(entryByPath("src/config.ts")),
		).toMatchObject({ status: "indexed" });
		expect(
			(await readSymbolIndex(fs, paths)).find(entryById("sym_parse_config")),
		).toMatchObject({
			verification: { status: "verified" },
		});
	});

	it("persists dirty state and stale/missing verification statuses when applied", async () => {
		const fs = new MockPlannerFs();
		const paths = await initializeTestMemory(fs);
		await seedMemory(fs, paths);

		const result = await applyMemoryFreshness({
			fs,
			paths,
			currentFiles: [
				{ path: "src/config.ts", hash: "hash:changed" },
				{ path: "src/env.ts", hash: "hash:src/env.ts" },
				{ path: "src/new.ts", hash: "hash:new" },
			],
			detectedAt: "2026-05-23T11:00:00.000Z",
		});

		expect(result.filesToReindex).toEqual([
			"src/config.ts",
			"src/new.ts",
			"src/server.ts",
		]);
		expect(
			(await readFileIndex(fs, paths)).find(entryByPath("src/config.ts")),
		).toMatchObject({ status: "dirty" });
		expect(
			(await readFileIndex(fs, paths)).find(entryByPath("src/server.ts")),
		).toMatchObject({ status: "missing" });
		expect(
			(await readSymbolIndex(fs, paths)).find(entryById("sym_parse_config")),
		).toMatchObject({
			verification: { status: "stale" },
		});
		expect(
			(await readSymbolIndex(fs, paths)).find(entryById("sym_start_server")),
		).toMatchObject({
			verification: { status: "missing" },
		});
		expect(await readMemoryDirtyState(fs, paths)).toEqual({
			files: {
				"src/config.ts": {
					reason: "file_hash_changed",
					detectedAt: "2026-05-23T11:00:00.000Z",
				},
				"src/new.ts": {
					reason: "file_hash_changed",
					detectedAt: "2026-05-23T11:00:00.000Z",
				},
				"src/server.ts": {
					reason: "verification_failed",
					detectedAt: "2026-05-23T11:00:00.000Z",
				},
			},
		});
		expect(result.dirty).toEqual(await readMemoryDirtyState(fs, paths));
	});

	it("returns clean result when snapshot matches the file index", async () => {
		const fs = new MockPlannerFs();
		const paths = await initializeTestMemory(fs);
		await seedMemory(fs, paths);

		await expect(
			analyzeMemoryFreshness({
				fs,
				paths,
				currentFiles: [
					{ path: "src/config.ts", hash: "hash:src/config.ts" },
					{ path: "src/env.ts", hash: "hash:src/env.ts" },
					{ path: "src/server.ts", hash: "hash:src/server.ts" },
				],
			}),
		).resolves.toMatchObject({
			clean: true,
			changedFiles: [],
			missingFiles: [],
			newFiles: [],
			filesToReindex: [],
		});
	});

	it("keeps existing dirty state when clean apply has nothing to change", async () => {
		const fs = new MockPlannerFs();
		const paths = await initializeTestMemory(fs);
		await seedMemory(fs, paths);
		await applyMemoryFreshness({
			fs,
			paths,
			currentFiles: [
				{ path: "src/config.ts", hash: "hash:changed" },
				{ path: "src/env.ts", hash: "hash:src/env.ts" },
				{ path: "src/server.ts", hash: "hash:src/server.ts" },
			],
			detectedAt: "2026-05-23T11:00:00.000Z",
		});

		const clean = await applyMemoryFreshness({
			fs,
			paths,
			currentFiles: [
				{ path: "src/config.ts", hash: "hash:src/config.ts" },
				{ path: "src/env.ts", hash: "hash:src/env.ts" },
				{ path: "src/server.ts", hash: "hash:src/server.ts" },
			],
			detectedAt: "2026-05-23T12:00:00.000Z",
		});

		expect(clean.clean).toBe(true);
		expect(clean.dirty).toEqual({
			files: {
				"src/config.ts": {
					reason: "file_hash_changed",
					detectedAt: "2026-05-23T11:00:00.000Z",
				},
			},
		});
	});

	it("treats duplicate snapshot paths as last value wins", async () => {
		const fs = new MockPlannerFs();
		const paths = await initializeTestMemory(fs);
		await seedMemory(fs, paths);

		const result = await analyzeMemoryFreshness({
			fs,
			paths,
			currentFiles: [
				{ path: "src/config.ts", hash: "hash:wrong" },
				{ path: "src/config.ts", hash: "hash:src/config.ts" },
				{ path: "src/env.ts", hash: "hash:src/env.ts" },
				{ path: "src/server.ts", hash: "hash:src/server.ts" },
			],
		});

		expect(result.clean).toBe(true);
		expect(result.changedFiles).toEqual([]);
	});

	it("marks relations affected through changed source or target symbols", async () => {
		const fs = new MockPlannerFs();
		const paths = await initializeTestMemory(fs);
		await seedMemory(fs, paths);
		await upsertRelationEntries(fs, paths, [
			relationEntry("rel_env_config", "sym_load_env", "sym_parse_config"),
		]);

		const result = await analyzeMemoryFreshness({
			fs,
			paths,
			currentFiles: [
				{ path: "src/config.ts", hash: "hash:changed" },
				{ path: "src/env.ts", hash: "hash:src/env.ts" },
				{ path: "src/server.ts", hash: "hash:src/server.ts" },
			],
		});

		expect(result.affectedSymbolIds).toEqual(["sym_parse_config"]);
		expect(result.affectedRelationIds).toEqual([
			"rel_env_config",
			"rel_server_config",
		]);
	});

	it("rejects unsafe snapshot paths before touching memory indexes", async () => {
		const fs = new MockPlannerFs();
		const paths = await initializeTestMemory(fs);
		await seedMemory(fs, paths);

		await expect(
			applyMemoryFreshness({
				fs,
				paths,
				currentFiles: [{ path: "../outside.ts", hash: "hash:outside" }],
				detectedAt: "2026-05-23T11:00:00.000Z",
			}),
		).rejects.toThrow("Snapshot path must not contain parent traversal");
		expect(
			(await readFileIndex(fs, paths)).find(entryByPath("src/config.ts")),
		).toMatchObject({ status: "indexed" });
	});

	it("rejects windows absolute paths and empty snapshot hashes", async () => {
		const fs = new MockPlannerFs();
		const paths = await initializeTestMemory(fs);
		await seedMemory(fs, paths);

		await expect(
			analyzeMemoryFreshness({
				fs,
				paths,
				currentFiles: [{ path: "C:\\repo\\src\\config.ts", hash: "hash" }],
			}),
		).rejects.toThrow("Snapshot path must be relative");
		await expect(
			analyzeMemoryFreshness({
				fs,
				paths,
				currentFiles: [{ path: "src/config.ts", hash: "" }],
			}),
		).rejects.toThrow("Snapshot hash must be non-empty");
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

async function seedMemory(
	fs: MockPlannerFs,
	paths: Awaited<ReturnType<typeof initializeTestMemory>>,
) {
	await upsertFileEntries(fs, paths, [
		fileEntry("src/config.ts"),
		fileEntry("src/env.ts"),
		fileEntry("src/server.ts"),
	]);
	await upsertSymbolEntries(fs, paths, [
		symbolEntry("sym_parse_config", "src/config.ts"),
		symbolEntry("sym_load_env", "src/env.ts"),
		symbolEntry("sym_start_server", "src/server.ts"),
	]);
	await upsertRelationEntries(fs, paths, [
		relationEntry("rel_server_config", "sym_start_server", "sym_parse_config"),
	]);
	expect(await readRelationIndex(fs, paths)).toHaveLength(1);
}

function fileEntry(path: string): MemoryFileEntry {
	return {
		path,
		kind: "source",
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
			globalState: "none",
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
		kind: "calls",
		evidencePath: "src/server.ts",
		evidenceSearchText: "parseConfig(",
	};
}

function entryByPath(path: string): (entry: MemoryFileEntry) => boolean {
	return (entry) => entry.path === path;
}

function entryById(id: string): (entry: MemorySymbolEntry) => boolean {
	return (entry) => entry.id === id;
}
