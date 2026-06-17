import { describe, expect, it } from "vitest";
import type { PlannerExecSettings } from "../settings/schema";
import type { PlannerFs } from "../storage/fs";
import type { PlanStoragePaths } from "../storage/paths";
import type { PlanStateRecord } from "../storage/schema";
import { executePlannerExecTool } from "./exec-tools";

// Minimal stub — exec-tools only calls updatePlanState which reads/writes state.json.
function makeStubs(): {
	fs: PlannerFs;
	planPaths: PlanStoragePaths;
	settings: PlannerExecSettings;
} {
	let stored: PlanStateRecord = {
		execRunning: false,
	} as unknown as PlanStateRecord;

	const fs: PlannerFs = {
		readText: async () => JSON.stringify(stored),
		writeTextAtomic: async (_path: string, data: string) => {
			stored = JSON.parse(data) as PlanStateRecord;
		},
		exists: async () => true,
		mkdirp: async () => {},
		isDirectory: async () => false,
		readdir: async () => [],
		removeDir: async () => {},
		removeFile: async () => {},
		writeText: async (_path: string, data: string) => {
			stored = JSON.parse(data) as PlanStateRecord;
		},
	};

	const planPaths: PlanStoragePaths = {
		stateJson: "/fake/state.json",
		planDir: "/fake",
	} as unknown as PlanStoragePaths;

	const settings: PlannerExecSettings = {
		defaultTimeoutSeconds: 10,
		maxTimeoutSeconds: 30,
		maxOutputBytes: 10 * 1024 * 1024,
	};

	return { fs, planPaths, settings };
}

const worktreePath = process.cwd();

describe("executePlannerExecTool", () => {
	it("returns stdout on success", async () => {
		const { fs, planPaths, settings } = makeStubs();
		const result = await executePlannerExecTool({
			params: { command: 'echo "hello world"' },
			fs,
			planPaths,
			settings,
			worktreePath,
		});
		expect(result.text).toContain("Command completed successfully.");
		expect(result.text).toContain("hello world");
	});

	it("returns exit code on failure", async () => {
		const { fs, planPaths, settings } = makeStubs();
		const result = await executePlannerExecTool({
			params: { command: "exit 42" },
			fs,
			planPaths,
			settings,
			worktreePath,
		});
		expect(result.text).toContain("Command failed (exit 42).");
	});

	it("captures stderr", async () => {
		const { fs, planPaths, settings } = makeStubs();
		const result = await executePlannerExecTool({
			params: { command: 'echo "err msg" >&2' },
			fs,
			planPaths,
			settings,
			worktreePath,
		});
		expect(result.text).toContain("err msg");
	});

	it("times out and kills the process", async () => {
		const { fs, planPaths, settings } = makeStubs();
		const result = await executePlannerExecTool({
			params: { command: "sleep 60", timeoutSeconds: 0.2 },
			fs,
			planPaths,
			settings,
			worktreePath,
		});
		expect(result.text).toContain("timed out after 0.2s");
		expect(result.text).toContain("process tree killed");
	}, 5000);

	it("caps timeoutSeconds to maxTimeoutSeconds and notes the cap", async () => {
		const { fs, planPaths, settings } = makeStubs();
		const result = await executePlannerExecTool({
			params: { command: 'echo "ok"', timeoutSeconds: 9999 },
			fs,
			planPaths,
			settings,
			worktreePath,
		});
		expect(result.text).toContain(
			`requested 9999s was capped to ${settings.maxTimeoutSeconds}s`,
		);
		expect(result.text).toContain("Command completed successfully.");
	});

	it("decodes multi-byte UTF-8 across chunk boundaries correctly", async () => {
		const { fs, planPaths, settings } = makeStubs();
		// printf outputs exact bytes; this string contains Cyrillic (2-byte UTF-8 chars).
		const result = await executePlannerExecTool({
			params: { command: 'printf "Привет мир"' },
			fs,
			planPaths,
			settings,
			worktreePath,
		});
		expect(result.text).toContain("Привет мир");
	});

	it("truncates output exceeding maxOutputBytes", async () => {
		const { fs, planPaths, settings } = makeStubs();
		const tinySettings = { ...settings, maxOutputBytes: 10 };
		const result = await executePlannerExecTool({
			params: {
				command: 'echo "this output is definitely longer than ten bytes"',
			},
			fs,
			planPaths,
			settings: tinySettings,
			worktreePath,
		});
		expect(result.text).toContain("Output truncated");
	});
});
