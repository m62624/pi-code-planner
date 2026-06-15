import { join } from "node:path";
import type { GitRunner } from "../git/runner";
import type { PlannerFs } from "../storage/fs";
import type { ProjectStoragePaths } from "../storage/paths";
import {
	checkPlannerOrchestratorToolAllowed,
	runPlannerOrchestrator,
} from "./orchestrator";
import {
	mergeTddMarkdown,
	renderTddSection,
	TDD_SECTIONS,
	type TddSectionKey,
} from "./tdd-form";

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
				await input.fs.writeTextAtomic(planPaths.planMd, `${content}\n`);
				return applied(input.toolName, planPaths.planMd, "Planner plan saved.");
			}
			case "planner_discovery_submit": {
				const body = requiredString(params, "body");
				const protocol = requiredStringArray(params, "verificationProtocol");
				const content = [
					body,
					"",
					"## Verification Protocol",
					...protocol.map((command) => `- ${command}`),
				].join("\n");
				await input.fs.writeTextAtomic(planPaths.discoveryMd, `${content}\n`);
				return applied(
					input.toolName,
					planPaths.discoveryMd,
					"Planner discovery saved with a ## Verification Protocol section.",
				);
			}
			case "planner_summary_submit": {
				const content = requiredString(params, "content");
				const summaryPath = join(planPaths.planDir, "final_summary.md");
				await input.fs.writeTextAtomic(summaryPath, `${content}\n`);
				return applied(
					input.toolName,
					summaryPath,
					"Planner final summary saved.",
				);
			}
			case "planner_tdd_submit": {
				if (!state.activeTaskId) {
					return blocked(
						input.toolName,
						"planner_tdd_submit requires an active task. Prepare exactly one task branch first.",
					);
				}
				const updates = renderTddUpdates(params);
				if (Object.keys(updates).length === 0) {
					return blocked(
						input.toolName,
						`Provide at least one section: ${TDD_SECTIONS.map((s) => s.key).join(", ")}.`,
					);
				}
				const tddPath = join(planPaths.tasksDir, state.activeTaskId, "tdd.md");
				const existing = (await input.fs.exists(tddPath))
					? await input.fs.readText(tddPath)
					: "";
				const content = mergeTddMarkdown(existing, updates);
				await input.fs.writeTextAtomic(tddPath, content);
				return applied(
					input.toolName,
					tddPath,
					`Planner tdd.md updated (${Object.keys(updates).join(", ")}).`,
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

function applied(
	toolName: PlannerArtifactToolName,
	path: string,
	headline: string,
): PlannerArtifactToolExecutionResult {
	return {
		status: "applied",
		toolName,
		text: [
			headline,
			`Artifact: ${path}`,
			"Continue the current step; the next-step hint follows after planner_finish_step.",
		].join("\n"),
		details: { path },
	};
}

function blocked(
	toolName: PlannerArtifactToolName,
	text: string,
): PlannerArtifactToolExecutionResult {
	return { status: "blocked", toolName, text, details: null };
}

function asObject(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function requiredString(params: Record<string, unknown>, key: string): string {
	const value = params[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError(`${key} must be a non-empty string.`);
	}
	return value.trim();
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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
