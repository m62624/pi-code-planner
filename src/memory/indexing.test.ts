import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
	GitBranchInput,
	GitCommitInput,
	GitCreateBranchInput,
	GitDeleteBranchInput,
	GitMergeInput,
	GitRepoInput,
	GitRunner,
	GitSwitchBranchInput,
	GitWorktreeAddInput,
	GitWorktreeRemoveInput,
} from "../git/runner";
import {
	createPlanStoragePaths,
	createProjectStoragePaths,
} from "../storage/paths";
import { MockPlannerFs } from "../test/mock-fs";
import {
	addActiveMemoryCandidateSymbols,
	claimNextMemoryIndexingFile,
	completeActiveMemoryFile,
	ignoreActiveMemoryFile,
	isMemoryIndexingComplete,
	readActiveMemoryFileChunk,
	readMemoryIndexingState,
	scanMemoryIndexingQueue,
	summarizeMemoryIndexing,
	upsertActiveMemoryFile,
	verifyActiveMemoryFile,
} from "./indexing";
import {
	initializeMemoryFiles,
	readFileIndex,
	readRelationIndex,
	readSymbolIndex,
	upsertFileEntries,
	upsertRelationEntries,
	upsertSymbolEntries,
} from "./manager";
import { createMemoryStoragePaths } from "./paths";
import type { MemorySymbolEntry } from "./schema";

class MockGitRunner implements GitRunner {
	constructor(private readonly files: string[]) {}

	async init(_input: GitRepoInput): Promise<void> {}
	async currentBranch(_input: GitRepoInput): Promise<string> {
		return "plan/plan-a";
	}
	async headCommit(_input: GitRepoInput): Promise<string> {
		return "abc123";
	}
	async statusPorcelain(_input: GitRepoInput): Promise<string> {
		return "";
	}
	async diffStat(_input: GitRepoInput): Promise<string> {
		return "";
	}
	async diffNameOnly(_input: GitRepoInput): Promise<string> {
		return "";
	}
	async listProjectFiles(_input: GitRepoInput): Promise<string[]> {
		return this.files;
	}
	async branchExists(_input: GitBranchInput): Promise<boolean> {
		return true;
	}
	async createBranch(_input: GitCreateBranchInput): Promise<void> {}
	async deleteBranch(_input: GitDeleteBranchInput): Promise<void> {}
	async switchBranch(_input: GitSwitchBranchInput): Promise<void> {}
	async stageAll(_input: GitRepoInput): Promise<void> {}
	async commit(_input: GitCommitInput): Promise<void> {}
	async merge(_input: GitMergeInput): Promise<void> {}
	async worktreeAdd(_input: GitWorktreeAddInput): Promise<void> {}
	async worktreeRemove(_input: GitWorktreeRemoveInput): Promise<void> {}
}

describe("iterative memory indexing", () => {
	it("persists bounded line progress and resumes the same active file", async () => {
		const setup = await createSetup({
			"src/a.ts": ["line 1", "line 2", "line 3", "line 4", "line 5"].join("\n"),
		});

		await scanMemoryIndexingQueue({
			...setup,
			mode: "initial_discovery",
		});
		await expect(
			claimNextMemoryIndexingFile(setup.fs, setup.paths),
		).resolves.toMatchObject({
			path: "src/a.ts",
			status: "reading",
			nextUnreadLine: 1,
		});

		const first = await readActiveMemoryFileChunk({ ...setup, maxLines: 2 });
		expect(first).toMatchObject({
			path: "src/a.ts",
			startLine: 1,
			endLine: 2,
			nextUnreadLine: 3,
			eof: false,
		});
		expect(first.content).toBe("1 | line 1\n2 | line 2");

		await scanMemoryIndexingQueue({
			...setup,
			mode: "initial_discovery",
		});
		expect(await readMemoryIndexingState(setup.fs, setup.paths)).toMatchObject({
			activeFile: "src/a.ts",
			files: [{ path: "src/a.ts", nextUnreadLine: 3, status: "reading" }],
		});

		const second = await readActiveMemoryFileChunk({ ...setup, maxLines: 20 });
		expect(second).toMatchObject({
			startLine: 3,
			endLine: 5,
			nextUnreadLine: 6,
			eof: true,
		});
	});

	it("requires full read, exact symbol anchors, verification, and completion before the next file", async () => {
		const setup = await createSetup({
			"src/a.ts":
				"export function parse(input: string): string {\n\treturn input;\n}\n",
			"src/b.ts": "export const value = 1;\n",
		});
		await scanMemoryIndexingQueue({ ...setup, mode: "initial_discovery" });
		await claimNextMemoryIndexingFile(setup.fs, setup.paths);

		await expect(
			upsertActiveMemoryFile({
				...setup,
				kind: "source",
				language: "ts",
				summary: "Parser.",
			}),
		).rejects.toThrow("not fully read");

		await readActiveMemoryFileChunk({ ...setup, maxLines: 20 });
		await upsertActiveMemoryFile({
			...setup,
			kind: "source",
			language: "ts",
			summary: "Parser.",
		});
		const symbol = symbolEntry({
			path: "src/a.ts",
			hash: sha256(
				"export function parse(input: string): string {\n\treturn input;\n}\n",
			),
			anchor: "export function parse(input: string): string",
		});
		await upsertSymbolEntries(setup.fs, setup.paths, [symbol]);
		await addActiveMemoryCandidateSymbols({
			fs: setup.fs,
			paths: setup.paths,
			symbols: [symbol],
		});
		await verifyActiveMemoryFile(setup);

		await expect(
			claimNextMemoryIndexingFile(setup.fs, setup.paths),
		).resolves.toMatchObject({ path: "src/a.ts", status: "verifying" });
		await completeActiveMemoryFile(setup);
		await expect(
			claimNextMemoryIndexingFile(setup.fs, setup.paths),
		).resolves.toMatchObject({ path: "src/b.ts", status: "reading" });
	});

	it("rejects completion when a candidate anchor disappeared", async () => {
		const source = "export const value = 1;\n";
		const setup = await createSetup({ "src/a.ts": source });
		await scanMemoryIndexingQueue({ ...setup, mode: "initial_discovery" });
		await claimNextMemoryIndexingFile(setup.fs, setup.paths);
		await readActiveMemoryFileChunk({ ...setup });
		await upsertActiveMemoryFile({
			...setup,
			kind: "source",
			language: "ts",
			summary: "Value.",
		});
		const symbol = symbolEntry({
			path: "src/a.ts",
			hash: sha256(source),
			anchor: "missing anchor",
		});
		await upsertSymbolEntries(setup.fs, setup.paths, [symbol]);
		await addActiveMemoryCandidateSymbols({
			fs: setup.fs,
			paths: setup.paths,
			symbols: [symbol],
		});

		await expect(verifyActiveMemoryFile(setup)).rejects.toThrow(
			"anchor was not found",
		);
	});

	it("rejects a file changed between chunks and requires a rescan", async () => {
		const setup = await createSetup({ "src/a.ts": "one\ntwo\nthree\n" });
		await scanMemoryIndexingQueue({ ...setup, mode: "initial_discovery" });
		await claimNextMemoryIndexingFile(setup.fs, setup.paths);
		await readActiveMemoryFileChunk({ ...setup, maxLines: 1 });
		await setup.fs.writeText(`${setup.repoRoot}/src/a.ts`, "one\nchanged\n");

		await expect(
			readActiveMemoryFileChunk({ ...setup, maxLines: 1 }),
		).rejects.toThrow("changed during indexing");

		await scanMemoryIndexingQueue({ ...setup, mode: "initial_discovery" });
		expect(await readMemoryIndexingState(setup.fs, setup.paths)).toMatchObject({
			activeFile: null,
			files: [{ path: "src/a.ts", status: "pending", nextUnreadLine: 1 }],
		});
	});

	it("rejects a corrupted persisted queue before any indexing action", async () => {
		const setup = await createSetup({ "src/a.ts": "one\n" });
		await setup.fs.writeText(
			setup.paths.indexingJson,
			JSON.stringify({
				mode: "initial_discovery",
				activeFile: null,
				files: [
					{
						path: "src/a.ts",
						hash: sha256("one\n"),
						status: "reading",
						lineCount: 1,
						nextUnreadLine: 1,
						candidateSymbolIds: [],
						verificationPassed: false,
						failureReason: null,
					},
				],
			}),
		);

		await expect(
			readMemoryIndexingState(setup.fs, setup.paths),
		).rejects.toThrow("requires activeFile");
	});

	it("allows explicit ignore and treats ignored files as terminal", async () => {
		const setup = await createSetup({ "generated.lock": "generated\n" });
		await scanMemoryIndexingQueue({ ...setup, mode: "initial_discovery" });
		await claimNextMemoryIndexingFile(setup.fs, setup.paths);
		const state = await ignoreActiveMemoryFile({
			...setup,
			kind: "generated",
			language: "text",
			summary:
				"Generated lock file; intentionally excluded from symbol memory.",
		});

		expect(summarizeMemoryIndexing(state)).toMatchObject({
			ignored: 1,
			complete: true,
		});
		await expect(isMemoryIndexingComplete(setup.fs, setup.paths)).resolves.toBe(
			true,
		);
		expect(await readFileIndex(setup.fs, setup.paths)).toMatchObject([
			{ path: "generated.lock", status: "ignored" },
		]);
	});

	it("refreshes only selected files and purges removed file symbols and relations", async () => {
		const setup = await createSetup({ "src/a.ts": "export const a = 1;\n" });
		const removedSymbol = symbolEntry({
			path: "src/removed.ts",
			hash: "old-hash",
			anchor: "removed",
		});
		await upsertFileEntries(setup.fs, setup.paths, [
			{
				path: "src/removed.ts",
				kind: "source",
				language: "ts",
				hash: "old-hash",
				status: "indexed",
				summary: "Removed.",
			},
		]);
		await upsertSymbolEntries(setup.fs, setup.paths, [removedSymbol]);
		await upsertRelationEntries(setup.fs, setup.paths, [
			{
				id: "rel_removed",
				from: removedSymbol.id,
				to: null,
				kind: "exposes",
				evidencePath: "src/removed.ts",
				evidenceSearchText: "removed",
			},
		]);

		const state = await scanMemoryIndexingQueue({
			...setup,
			mode: "refresh",
			onlyPaths: ["src/a.ts", "src/removed.ts"],
		});

		expect(state.files).toMatchObject([
			{ path: "src/a.ts", status: "pending" },
			{ path: "src/removed.ts", status: "missing" },
		]);
		expect(await readSymbolIndex(setup.fs, setup.paths)).toEqual([]);
		expect(await readRelationIndex(setup.fs, setup.paths)).toEqual([]);
	});

	it("removes obsolete symbols and relations when a refreshed file completes", async () => {
		const source = "export const current = 1;\n";
		const setup = await createSetup({ "src/a.ts": source });
		const obsolete = symbolEntry({
			id: "sym_obsolete",
			path: "src/a.ts",
			hash: sha256(source),
			anchor: "export const current = 1",
		});
		await upsertFileEntries(setup.fs, setup.paths, [
			{
				path: "src/a.ts",
				kind: "source",
				language: "ts",
				hash: sha256(source),
				status: "indexed",
				summary: "Old.",
			},
		]);
		await upsertSymbolEntries(setup.fs, setup.paths, [obsolete]);
		await upsertRelationEntries(setup.fs, setup.paths, [
			{
				id: "rel_obsolete",
				from: obsolete.id,
				to: null,
				kind: "exposes",
				evidencePath: "src/a.ts",
				evidenceSearchText: "export const current = 1",
			},
		]);

		await scanMemoryIndexingQueue({
			...setup,
			mode: "refresh",
			onlyPaths: ["src/a.ts"],
		});
		await claimNextMemoryIndexingFile(setup.fs, setup.paths);
		await readActiveMemoryFileChunk({ ...setup });
		await upsertActiveMemoryFile({
			...setup,
			kind: "source",
			language: "ts",
			summary: "Current.",
		});
		await verifyActiveMemoryFile(setup);
		await completeActiveMemoryFile(setup);

		expect(await readSymbolIndex(setup.fs, setup.paths)).toEqual([]);
		expect(await readRelationIndex(setup.fs, setup.paths)).toEqual([]);
	});
});

async function createSetup(files: Record<string, string>) {
	const fs = new MockPlannerFs();
	const repoRoot = "/repo/app";
	const planPaths = createPlanStoragePaths(
		createProjectStoragePaths({ agentDir: "/agent", projectRoot: repoRoot }),
		"plan-a",
	);
	const paths = createMemoryStoragePaths(planPaths);
	await initializeMemoryFiles(fs, planPaths);
	for (const [path, content] of Object.entries(files)) {
		await fs.writeText(`${repoRoot}/${path}`, content);
	}
	return {
		fs,
		git: new MockGitRunner(Object.keys(files)),
		repoRoot,
		paths,
	};
}

function symbolEntry(input: {
	id?: string;
	path: string;
	hash: string;
	anchor: string;
}): MemorySymbolEntry {
	return {
		id: input.id ?? "sym_parse",
		path: input.path,
		language: "ts",
		kind: "function",
		name: "parse",
		qualifiedName: "parse",
		signature: input.anchor,
		summary: "Reusable symbol.",
		visibility: "public",
		effects: { reads: [], writes: [], io: [], globalState: "none" },
		anchor: { searchText: input.anchor },
		verification: { fileHash: input.hash, status: "verified" },
	};
}

function sha256(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}
