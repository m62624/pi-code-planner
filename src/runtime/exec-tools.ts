import { exec } from "node:child_process";
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
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), timeoutMs);

		exec(
			params.command,
			{ cwd, signal: ac.signal, maxBuffer: 10 * 1024 * 1024 },
			(err, stdout, stderr) => {
				clearTimeout(timer);

				updatePlanState(fs, planPaths, (s) => ({
					...s,
					execRunning: false,
				})).catch(() => {});

				if (err && ac.signal.aborted) {
					resolve({
						text: [
							cappedNote +
								`Command timed out after ${timeoutSeconds}s — process killed.`,
							`Command: ${params.command}`,
							`If this operation is expected to take longer, retry with a higher timeoutSeconds (max: ${settings.maxTimeoutSeconds}).`,
						].join("\n"),
					});
					return;
				}

				const out = [stdout, stderr].filter(Boolean).join("\n").trim();
				if (err) {
					resolve({
						text: [
							cappedNote + `Command failed (exit ${err.code ?? "unknown"}).`,
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
			},
		);
	});
}
