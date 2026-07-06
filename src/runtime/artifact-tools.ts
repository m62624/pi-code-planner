import { join } from "node:path";
import { errorMessage } from "../errors";
import type { GitRunner } from "../git/runner";
import type { PlannerFs } from "../storage/fs";
import {
	createTaskStoragePaths,
	type PlanStoragePaths,
	type ProjectStoragePaths,
} from "../storage/paths";
import { readPlanRecord } from "../storage/plan-store";
import { readActivePlanContext } from "./active-plan";
import { ARTIFACT_CANONICAL_SCHEMA, formatArtifactEcho } from "./artifact-echo";
import {
	checkPlannerOrchestratorToolAllowed,
	runPlannerOrchestrator,
} from "./orchestrator";
import { asObject, requiredString } from "./params";
import {
	mergeTddMarkdown,
	renderTddSection,
	TDD_SECTIONS,
	type TddSectionKey,
} from "./tdd-form";
import { blockedResult } from "./tool-result";

export const PLANNER_ARTIFACT_TOOL_NAMES = [
	"planner_plan_submit",
	"planner_discovery_submit",
	"planner_tdd_submit",
	"planner_summary_submit",
] as const;

export type PlannerArtifactToolName =
	(typeof PLANNER_ARTIFACT_TOOL_NAMES)[number];

export interface PlannerArtifactToolExecutionResult {
	status: "applied" | "blocked";
	toolName: PlannerArtifactToolName;
	text: string;
	details: { path: string } | null;
}

export async function executePlannerArtifactTool(input: {
	fs: PlannerFs;
	git: GitRunner;
	projectPaths: ProjectStoragePaths;
	toolName: PlannerArtifactToolName;
	params: unknown;
}): Promise<PlannerArtifactToolExecutionResult> {
	const orchestrator = await runPlannerOrchestrator(input);
	if (orchestrator.preflight.context.status !== "ready") {
		return blocked(input.toolName, orchestrator.preflight.context.reason);
	}
	const policy = checkPlannerOrchestratorToolAllowed({
		orchestrator,
		toolName: input.toolName,
	});
	if (!policy.allow) {
		return blocked(
			input.toolName,
			policy.reason ?? `Planner artifact tool ${input.toolName} is blocked.`,
		);
	}

	const { state, planPaths } = orchestrator.preflight.context;
	try {
		const params = asObject(input.params);
		switch (input.toolName) {
			case "planner_plan_submit": {
				const content = requiredString(params, "content");
				const written = `${content}\n`;
				await input.fs.writeTextAtomic(planPaths.planMd, written);
				return applied(
					input.toolName,
					planPaths.planMd,
					"Planner plan saved.",
					written,
				);
			}
			case "planner_discovery_submit": {
				const body = requiredString(params, "body");
				const protocol = requiredStringArray(params, "verificationProtocol");
				const written = `${buildDiscoveryMarkdown(body, protocol)}\n`;
				await input.fs.writeTextAtomic(planPaths.discoveryMd, written);
				return applied(
					input.toolName,
					planPaths.discoveryMd,
					"Planner discovery saved. The ## Verification Protocol section is rebuilt from the verificationProtocol argument (any protocol section written in body is dropped).",
					written,
				);
			}
			case "planner_summary_submit": {
				const content = requiredString(params, "content");
				const summaryPath = join(planPaths.planDir, "final_summary.md");
				const written = `${content}\n`;
				await input.fs.writeTextAtomic(summaryPath, written);
				return applied(
					input.toolName,
					summaryPath,
					"Planner final summary saved.",
					written,
				);
			}
			case "planner_tdd_submit": {
				const updates = renderTddUpdates(params);
				if (Object.keys(updates).length === 0) {
					return blocked(
						input.toolName,
						`Provide at least one section: ${TDD_SECTIONS.map((s) => s.key).join(", ")}.`,
					);
				}
				// Normally the active task owns tdd.md. After planner_git_merge_task_to_plan
				// the active task is cleared, but the merge_task_to_plan exit gate still
				// wants the merge scope audit. Fall back to the latest done task for a
				// mergeScopeAudit-only submit so that state can never become terminal.
				const isMergeAuditOnly =
					Object.keys(updates).length === 1 &&
					updates.mergeScopeAudit !== undefined;
				const targetTaskId =
					state.activeTaskId ??
					(isMergeAuditOnly
						? await latestDoneTaskId(input.fs, planPaths)
						: null);
				if (!targetTaskId) {
					return blocked(
						input.toolName,
						"planner_tdd_submit requires an active task. Prepare exactly one task branch first.",
					);
				}
				const tddPath = join(planPaths.tasksDir, targetTaskId, "tdd.md");
				const existing = (await input.fs.exists(tddPath))
					? await input.fs.readText(tddPath)
					: "";
				const content = mergeTddMarkdown(existing, updates);
				await input.fs.writeTextAtomic(tddPath, content);
				return applied(
					input.toolName,
					tddPath,
					`Planner tdd.md updated (${Object.keys(updates).join(", ")}).`,
					content,
				);
			}
		}
	} catch (error) {
		return blocked(input.toolName, errorMessage(error));
	}
}

function renderTddUpdates(
	params: Record<string, unknown>,
): Partial<Record<TddSectionKey, string>> {
	const updates: Partial<Record<TddSectionKey, string>> = {};
	for (const def of TDD_SECTIONS) {
		const raw = params[def.key];
		if (raw === undefined || raw === null) {
			continue;
		}
		updates[def.key] = renderTddSection(
			def,
			asObject(raw) as Record<string, string>,
		);
	}
	return updates;
}

/** Latest task marked done, used as the audit target after a merge clears the active task. */
async function latestDoneTaskId(
	fs: PlannerFs,
	planPaths: PlanStoragePaths,
): Promise<string | null> {
	const plan = await readPlanRecord(fs, planPaths);
	for (let index = plan.tasks.length - 1; index >= 0; index -= 1) {
		if (plan.tasks[index]?.status === "done") {
			return plan.tasks[index].taskId;
		}
	}
	return null;
}

function applied(
	toolName: PlannerArtifactToolName,
	path: string,
	headline: string,
	written: string,
): PlannerArtifactToolExecutionResult {
	return {
		status: "applied",
		toolName,
		text: [
			headline,
			`Artifact: ${path}`,
			"",
			formatArtifactEcho({
				canonicalSchema: ARTIFACT_CANONICAL_SCHEMA[toolName],
				writtenMarkdown: written,
			}),
			"",
			"The next-step hint follows after planner_finish_step.",
		].join("\n"),
		details: { path },
	};
}

/** Assemble discovery.md from a free-form body plus the structured protocol
 * commands. The verificationProtocol argument is the single source of truth for
 * the ## Verification Protocol section, so any protocol section the model also
 * wrote into body is stripped first — otherwise discovery.md would carry two
 * `## Verification Protocol` sections and break the doubt_review protocol
 * parser. */
export function buildDiscoveryMarkdown(
	body: string,
	protocol: readonly string[],
): string {
	return [
		stripVerificationProtocolSection(body).trimEnd(),
		"",
		"## Verification Protocol",
		...protocol.map((command) => `- ${command}`),
	].join("\n");
}

/** Remove any `verification protocol` section (heading at any level plus its
 * lines, up to the next heading) from body. */
export function stripVerificationProtocolSection(body: string): string {
	const lines = body.split(/\r?\n/);
	const out: string[] = [];
	let skipping = false;
	for (const line of lines) {
		const heading = /^(#{1,6})\s+(\S.*)$/.exec(line.trim());
		if (heading) {
			skipping = heading[2].trim().toLowerCase() === "verification protocol";
			if (skipping) continue;
		}
		if (!skipping) out.push(line);
	}
	return out.join("\n");
}

function blocked(
	toolName: PlannerArtifactToolName,
	text: string,
): PlannerArtifactToolExecutionResult {
	return blockedResult(toolName, text);
}

function requiredStringArray(
	params: Record<string, unknown>,
	key: string,
): string[] {
	const value = params[key];
	if (!Array.isArray(value) || value.length === 0) {
		throw new TypeError(`${key} must be a non-empty array of strings.`);
	}
	return value.map((entry, index) => {
		if (typeof entry !== "string" || entry.trim().length === 0) {
			throw new TypeError(`${key}[${index}] must be a non-empty string.`);
		}
		return entry.trim();
	});
}

export const PLANNER_ARTIFACT_READ_TOOL_NAME = "planner_artifact_read";

/**
 * Transparency note for local models: this tool ONLY reads planner-managed
 * artifacts stored under the extension dir (getAgentDir/extensions/...). Project
 * source files in the worktree are read with the built-in read tool as usual.
 */
const ARTIFACT_READ_SCOPE_HINT =
	"planner_artifact_read reads ONLY planner artifacts in the extension storage dir (outside the worktree). For project source files in the worktree, use the normal read tool instead.";

/** Plan-level artifacts that live in the plan dir under the extension dir. */
const PLAN_LEVEL_ARTIFACTS = [
	"request",
	"goal",
	"discovery",
	"plan",
	"questions",
	"decisions",
	"verify",
	"final_summary",
] as const;

/** Task-scoped artifacts read from the active (or named) task's directory. */
const TASK_LEVEL_ARTIFACTS = ["task", "tdd", "refactor"] as const;

export const PLANNER_READABLE_ARTIFACTS = [
	...PLAN_LEVEL_ARTIFACTS,
	...TASK_LEVEL_ARTIFACTS,
] as const;

export type PlannerReadableArtifact =
	(typeof PLANNER_READABLE_ARTIFACTS)[number];

export interface PlannerArtifactReadToolResult {
	status: "applied" | "blocked";
	toolName: typeof PLANNER_ARTIFACT_READ_TOOL_NAME;
	text: string;
	details: {
		artifact: string | null;
		path: string | null;
		taskId: string | null;
		exists: boolean;
	} | null;
}

/**
 * Read a planner-managed markdown artifact from the extension storage dir
 * (getAgentDir/extensions/pi-code-planner/plans/...), NOT from the worktree.
 *
 * Built-in read/bash cannot reach these files reliably: they live outside the
 * project worktree, so security/approval extensions that restrict tool calls to
 * the worktree block them, and a model that guesses a worktree-relative path
 * hits ENOENT. This wrapper is the single sanctioned way for the model to
 * re-read request/goal/discovery/plan/questions/decisions/verify/final_summary
 * and the active task's task/tdd/refactor markdown. Cross-stage by design — a
 * re-read is always safe — so it bypasses the stage policy like planner_status.
 */
export async function executePlannerArtifactReadTool(input: {
	fs: PlannerFs;
	projectPaths: ProjectStoragePaths;
	params: unknown;
}): Promise<PlannerArtifactReadToolResult> {
	const toolName = PLANNER_ARTIFACT_READ_TOOL_NAME;
	const params = asObject(input.params);
	const artifact = stringOrNull(params.artifact);
	if (!artifact || !isReadableArtifact(artifact)) {
		return readBlocked(
			[
				artifact
					? `"${artifact}" is not a planner artifact this tool can read.`
					: 'planner_artifact_read needs an "artifact" parameter.',
				`Choose one of: ${PLANNER_READABLE_ARTIFACTS.join(", ")}.`,
				ARTIFACT_READ_SCOPE_HINT,
			].join("\n"),
			{ artifact: artifact ?? null, path: null, taskId: null, exists: false },
		);
	}

	const context = await readActivePlanContext({
		fs: input.fs,
		projectPaths: input.projectPaths,
	});
	if (context.status !== "ready") {
		return readBlocked(
			`planner_artifact_read requires a ready active plan context (${context.reason}).`,
			{ artifact, path: null, taskId: null, exists: false },
		);
	}

	const knownTaskIds = context.plan.tasks.map((task) => task.taskId);
	const resolved = resolveArtifactPath({
		artifact,
		planPaths: context.planPaths,
		activeTaskId: context.state.activeTaskId,
		requestedTaskId: stringOrNull(params.taskId),
		knownTaskIds,
	});
	if (!resolved.ok) {
		return readBlocked(resolved.error, {
			artifact,
			path: null,
			taskId: resolved.taskId,
			exists: false,
		});
	}

	const exists = await input.fs.exists(resolved.path);
	const raw = exists ? await input.fs.readText(resolved.path) : "";
	const body = raw.trim();
	const header = `Artifact: ${resolved.path}`;
	const text = !exists
		? `${header}\n\n(${artifact} has not been written yet — the file does not exist. This is expected if the lifecycle has not reached the step that produces it; if you actually need a different file, pick another artifact: ${PLANNER_READABLE_ARTIFACTS.join(", ")}.)`
		: body.length === 0
			? `${header}\n\n(${artifact} exists but is empty.)`
			: `${header}\n\n${raw.trimEnd()}`;

	return {
		status: "applied",
		toolName,
		text,
		details: { artifact, path: resolved.path, taskId: resolved.taskId, exists },
	};
}

function resolveArtifactPath(input: {
	artifact: PlannerReadableArtifact;
	planPaths: PlanStoragePaths;
	activeTaskId: string | null;
	requestedTaskId: string | null;
	knownTaskIds: readonly string[];
}):
	| { ok: true; path: string; taskId: string | null }
	| { ok: false; error: string; taskId: string | null } {
	const { planPaths } = input;
	switch (input.artifact) {
		case "request":
			return { ok: true, path: planPaths.requestMd, taskId: null };
		case "goal":
			return { ok: true, path: planPaths.goalMd, taskId: null };
		case "discovery":
			return { ok: true, path: planPaths.discoveryMd, taskId: null };
		case "plan":
			return { ok: true, path: planPaths.planMd, taskId: null };
		case "questions":
			return { ok: true, path: planPaths.questionsMd, taskId: null };
		case "decisions":
			return { ok: true, path: planPaths.decisionsMd, taskId: null };
		case "verify":
			return { ok: true, path: planPaths.verifyMd, taskId: null };
		case "final_summary":
			return {
				ok: true,
				path: join(planPaths.planDir, "final_summary.md"),
				taskId: null,
			};
		case "task":
		case "tdd":
		case "refactor": {
			const knownList =
				input.knownTaskIds.length > 0
					? `Known task ids: ${input.knownTaskIds.join(", ")}.`
					: "No tasks have been created yet.";
			const taskId = input.requestedTaskId ?? input.activeTaskId;
			if (!taskId) {
				return {
					ok: false,
					error: `planner_artifact_read of "${input.artifact}" is task-scoped: pass a "taskId" or select an active task first. ${knownList}`,
					taskId: null,
				};
			}
			if (
				input.requestedTaskId &&
				!input.knownTaskIds.includes(input.requestedTaskId)
			) {
				return {
					ok: false,
					error: `Task "${input.requestedTaskId}" does not exist in this plan. ${knownList}`,
					taskId: input.requestedTaskId,
				};
			}
			const taskPaths = createTaskStoragePaths(planPaths, taskId);
			const path =
				input.artifact === "task"
					? taskPaths.taskMd
					: input.artifact === "tdd"
						? taskPaths.tddMd
						: taskPaths.refactorMd;
			return { ok: true, path, taskId };
		}
	}
}

function isReadableArtifact(value: string): value is PlannerReadableArtifact {
	return (PLANNER_READABLE_ARTIFACTS as readonly string[]).includes(value);
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: null;
}

function readBlocked(
	text: string,
	details: NonNullable<PlannerArtifactReadToolResult["details"]>,
): PlannerArtifactReadToolResult {
	return {
		status: "blocked",
		toolName: PLANNER_ARTIFACT_READ_TOOL_NAME,
		text,
		details,
	};
}
