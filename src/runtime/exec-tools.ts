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

		// Collect raw chunks — concat into a single Buffer at the end so
		// multi-byte UTF-8 characters split across chunk boundaries decode correctly.
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let totalBytes = 0;
		let truncated = false;

		child.stdout.on("data", (chunk: Buffer) => {
			totalBytes += chunk.length;
			if (totalBytes <= settings.maxOutputBytes) {
				stdoutChunks.push(chunk);
			} else if (!truncated) {
				truncated = true;
			}
		});

		child.stderr.on("data", (chunk: Buffer) => {
			totalBytes += chunk.length;
			if (totalBytes <= settings.maxOutputBytes) {
				stderrChunks.push(chunk);
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

		const finish = (code: number | null) => {
			clearTimeout(timer);

			updatePlanState(fs, planPaths, (s) => ({
				...s,
				execRunning: false,
			})).catch(() => {});

			const stdout = Buffer.concat(stdoutChunks).toString("utf8");
			const stderr = Buffer.concat(stderrChunks).toString("utf8");
			const truncatedNote = truncated
				? `\n[Output truncated — exceeded ${settings.maxOutputBytes / 1024 / 1024} MB]\n`
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
						`${cappedNote}Command failed (exit ${code ?? "unknown"}).`,
						`Command: ${params.command}`,
						out || "(no output)",
					].join("\n"),
				});
				return;
			}

			resolve({
				text: [
					`${cappedNote}Command completed successfully.`,
					`Command: ${params.command}`,
					out || "(no output)",
				].join("\n"),
			});
		};

		child.on("close", finish);

		child.on("error", (err) => {
			clearTimeout(timer);
			updatePlanState(fs, planPaths, (s) => ({
				...s,
				execRunning: false,
			})).catch(() => {});
			resolve({
				text: [
					`${cappedNote}Command failed to start: ${err.message}`,
					`Command: ${params.command}`,
				].join("\n"),
			});
		});
	});
}
