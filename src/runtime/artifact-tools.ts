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
			"## Expected shape (canonical schema)",
			CANONICAL_SCHEMA[toolName],
			"",
			"## What you submitted (saved to disk)",
			"```markdown",
			written.trimEnd(),
			"```",
			"",
			"Compare the two: the saved artifact should follow the canonical shape above (headings/sections of the same kind — the exact wording of your prose is up to you). If a required section is missing or wrong, call the same tool again to overwrite it; otherwise continue. The next-step hint follows after planner_finish_step.",
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
		const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line.trim());
		if (heading) {
			skipping = heading[2].trim().toLowerCase() === "verification protocol";
			if (skipping) continue;
		}
		if (!skipping) out.push(line);
	}
	return out.join("\n");
}

/** Compact reference templates echoed back so the model sees the canonical
 * shape of each artifact next to what it actually wrote. */
export const CANONICAL_SCHEMA: Record<PlannerArtifactToolName, string> = {
	planner_plan_submit: [
		"# Plan: <title>",
		"## Goal",
		"## Scope        (in-scope vs out-of-scope)",
		"## Constraints",
		"## Risks",
		"## Checks       (how each task is verified)",
		"## Tasks        (ordered task sequence)",
	].join("\n"),
	planner_discovery_submit: [
		"# Discovery: <title>",
		"## Project Overview / boundaries / findings / fundamental rules",
		"(for change requests: ## Post-Implementation Snapshot / Completed Work / Remaining Work)",
		"",
		"NOTE: Do NOT write a `## Verification Protocol` heading in body — pass",
		"the commands in the verificationProtocol argument; the wrapper renders",
		"`## Verification Protocol` with one `- <command>` per line. That section",
		"is the single source doubt_review checks against.",
	].join("\n"),
	planner_tdd_submit: [
		"# tdd.md (per active task; sections added as the lifecycle reaches them)",
		`## ${TDD_SECTIONS[0].title}`,
		...TDD_SECTIONS[0].fields.map((f) => `- ${f}: <concrete evidence>`),
		`## ${TDD_SECTIONS[1].title}`,
		...TDD_SECTIONS[1].fields.map((f) => `- ${f}: <concrete evidence>`),
		`## ${TDD_SECTIONS[2].title}`,
		...TDD_SECTIONS[2].fields.map((f) => `- ${f}: <concrete evidence>`),
	].join("\n"),
	planner_summary_submit: [
		"# Final Summary",
		"## What changed",
		"## Verification evidence  (command → result)",
		"## Follow-ups",
	].join("\n"),
};

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
