import { spawn } from "node:child_process";
import treeKill from "tree-kill";
import type { PlannerExecSettings } from "../settings/schema";
import type { PlannerFs } from "../storage/fs";
import type { PlanStoragePaths } from "../storage/paths";
import { updatePlanState } from "../storage/state-store";

export const PLANNER_EXEC_TOOL_NAME = "planner_exec" as const;

export interface PlannerExecInput {
	toolName: typeof PLANNER_EXEC_TOOL_NAME;
	params: {
		command: string;
		timeoutSeconds?: number;
		cwd?: string;
	};
}

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

// Cross-platform shell invocation — matches what child_process.exec uses internally.
function shellArgs(command: string): [string, string[]] {
	return process.platform === "win32"
		? ["cmd", ["/d", "/s", "/c", command]]
		: ["sh", ["-c", command]];
}

export async function executePlannerExecTool(input: {
	params: PlannerExecInput["params"];
	fs: PlannerFs;
	planPaths: PlanStoragePaths;
	settings: PlannerExecSettings;
	worktreePath: string;
}): Promise<{ text: string }> {
	const { params, fs, planPaths, settings, worktreePath } = input;

	const requested = params.timeoutSeconds ?? settings.defaultTimeoutSeconds;
	const capped = requested > settings.maxTimeoutSeconds;
	// Cap at max — model cannot exceed the configured ceiling.
	const timeoutMs = Math.min(requested, settings.maxTimeoutSeconds) * 1000;
	const timeoutSeconds = timeoutMs / 1000;
	const cappedNote = capped
		? `Note: requested ${requested}s was capped to ${timeoutSeconds}s (exec.maxTimeoutSeconds).\n`
		: "";

	const cwd = params.cwd ?? worktreePath;

	await updatePlanState(fs, planPaths, (s) => ({ ...s, execRunning: true }));

	return new Promise((resolve) => {
		const [shell, args] = shellArgs(params.command);
		const child = spawn(shell, args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let totalBytes = 0;
		let truncated = false;

		child.stdout.on("data", (chunk: Buffer) => {
			totalBytes += chunk.length;
			if (totalBytes <= MAX_OUTPUT_BYTES) {
				stdout += chunk.toString();
			} else if (!truncated) {
				truncated = true;
			}
		});

		child.stderr.on("data", (chunk: Buffer) => {
			totalBytes += chunk.length;
			if (totalBytes <= MAX_OUTPUT_BYTES) {
				stderr += chunk.toString();
			} else if (!truncated) {
				truncated = true;
			}
		});

		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			if (child.pid !== undefined) {
				// tree-kill sends the signal to the entire process tree,
				// ensuring no orphan subprocesses remain after timeout.
				treeKill(child.pid, "SIGTERM");
			}
		}, timeoutMs);

		child.on("close", (code) => {
			clearTimeout(timer);

			updatePlanState(fs, planPaths, (s) => ({
				...s,
				execRunning: false,
			})).catch(() => {});

			const truncatedNote = truncated
				? `\n[Output truncated — exceeded ${MAX_OUTPUT_BYTES / 1024 / 1024} MB]\n`
				: "";
			const out =
				[stdout, stderr].filter(Boolean).join("\n").trim() + truncatedNote;

			if (timedOut) {
				resolve({
					text: [
						cappedNote +
							`Command timed out after ${timeoutSeconds}s — process tree killed.`,
						`Command: ${params.command}`,
						`If this operation is expected to take longer, retry with a higher timeoutSeconds (max: ${settings.maxTimeoutSeconds}).`,
					].join("\n"),
				});
				return;
			}

			if (code !== 0) {
				resolve({
					text: [
						cappedNote + `Command failed (exit ${code ?? "unknown"}).`,
						`Command: ${params.command}`,
						out || "(no output)",
					].join("\n"),
				});
				return;
			}

			resolve({
				text: [
					cappedNote + `Command completed successfully.`,
					`Command: ${params.command}`,
					out || "(no output)",
				].join("\n"),
			});
		});

		child.on("error", (err) => {
			clearTimeout(timer);
			updatePlanState(fs, planPaths, (s) => ({
				...s,
				execRunning: false,
			})).catch(() => {});
			resolve({
				text: [
					cappedNote + `Command failed to start: ${err.message}`,
					`Command: ${params.command}`,
				].join("\n"),
			});
		});
	});
}
