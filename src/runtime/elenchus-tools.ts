import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { errorMessage } from "../errors";
import { isPathInsideOrEqual } from "../path-utils";
import { runElenchusCheck } from "./elenchus-engine";
import {
	checkPlannerOrchestratorToolAllowed,
	runPlannerOrchestrator,
} from "./orchestrator";
import type { PlannerToolContext } from "./tool-context";

export const PLANNER_ELENCHUS_TOOL_NAME = "planner_elenchus_check" as const;
export type PlannerElenchusToolName = typeof PLANNER_ELENCHUS_TOOL_NAME;

export interface PlannerElenchusToolInput extends PlannerToolContext {
	params: unknown;
}

export interface PlannerElenchusToolResult {
	status: "applied" | "blocked";
	toolName: PlannerElenchusToolName;
	text: string;
	details: {
		resolution: "checked" | "not_applicable";
		verdict: string | null;
		sourcePath: string | null;
		resultPath: string | null;
		engineVersion: string | null;
	} | null;
}

type ElenchusParams =
	| {
			resolution: "checked";
			name: string;
			program: string;
			format: "json" | "human";
			values: Record<string, boolean> | undefined;
	  }
	| { resolution: "not_applicable"; name: string; reason: string };

const VERDICTS = [
	"CONSISTENT",
	"WARNING",
	"UNDERDETERMINED",
	"CONFLICT",
] as const;

/**
 * Run the bundled elenchus engine on a model-authored `.vrf` program, or record
 * a terminal `not_applicable` escape. The escape — mirroring doubt_review's
 * `not_a_bug` — is what keeps any step that nudges toward elenchus from ever
 * deadlocking: a plan with no interacting-constraint web resolves the step in
 * one call with a reason, without running the engine.
 *
 * Gating is generic: the orchestrator allows this tool only at the steps where
 * both guard/tool-policy and stage-behavior list it (consistency_check, the
 * discovery scan, doubt_review, and recovery repair).
 */
export async function executePlannerElenchusTool(
	input: PlannerElenchusToolInput,
): Promise<PlannerElenchusToolResult> {
	try {
		const orchestrator = await runPlannerOrchestrator(input);
		if (orchestrator.preflight.context.status !== "ready") {
			return blocked(orchestrator.preflight.context.reason);
		}
		const policy = checkPlannerOrchestratorToolAllowed({
			orchestrator,
			toolName: PLANNER_ELENCHUS_TOOL_NAME,
		});
		if (!policy.allow) {
			return blocked(
				policy.reason ?? "planner_elenchus_check is blocked by planner state.",
			);
		}

		const { planPaths } = orchestrator.preflight.context;
		const elenchusDir = planPaths.elenchusDir;
		const params = parseElenchusParams(input.params);

		if (params.resolution === "not_applicable") {
			return await recordNotApplicable(input, elenchusDir, params);
		}
		return await runCheck(input, elenchusDir, params);
	} catch (error) {
		return blocked(errorMessage(error));
	}
}

async function runCheck(
	input: PlannerElenchusToolInput,
	elenchusDir: string,
	params: Extract<ElenchusParams, { resolution: "checked" }>,
): Promise<PlannerElenchusToolResult> {
	const sourceName = `${params.name}.vrf`;
	const sourcePath = join(elenchusDir, sourceName);
	await input.fs.writeTextAtomic(sourcePath, normalizeProgram(params.program));

	// elenchus resolves IMPORTs through a synchronous read callback, so it reads
	// the just-written source (and any siblings it imports) straight off disk,
	// confined to the plan's elenchus dir.
	const read = (path: string): string => {
		const target = resolve(elenchusDir, path);
		if (!isPathInsideOrEqual(target, elenchusDir)) {
			throw new Error(`elenchus import escapes the plan dir: ${path}`);
		}
		return readFileSync(target, "utf8");
	};

	const run = await runElenchusCheck({
		root: sourceName,
		read,
		format: params.format,
		values: params.values,
	});
	if (!run.ok) {
		return blocked(run.reason);
	}

	const resultName =
		params.format === "human"
			? `${params.name}.result.md`
			: `${params.name}.result.json`;
	const resultPath = join(elenchusDir, resultName);
	await input.fs.writeTextAtomic(resultPath, `${run.output.trim()}\n`);

	const verdict = detectVerdict(run.output);
	const consistent = verdict === "CONSISTENT";
	return {
		status: "applied",
		toolName: PLANNER_ELENCHUS_TOOL_NAME,
		text: [
			`elenchus check "${params.name}" (${run.engineVersion}).`,
			`Source: ${sourcePath}`,
			`Result: ${resultPath}`,
			`Verdict: ${verdict ?? "(unrecognized)"}`,
			"",
			run.output.trim(),
			"",
			consistent
				? "CONSISTENT (exit 0): the modeled constraints hold. Record the conclusion in decisions.md, then call planner_finish_step."
				: "Not CONSISTENT yet. Read the verdict: add the FACT/NOT it names, pin down an UNDERDETERMINED model, or fix the wrong fact / conflicting premise — then call planner_elenchus_check again. The target before advancing is CONSISTENT; if a contradiction is real, fix the plan/tasks first.",
			"Call planner_status before choosing the next planner action.",
		].join("\n"),
		details: {
			resolution: "checked",
			verdict,
			sourcePath,
			resultPath,
			engineVersion: run.engineVersion,
		},
	};
}

async function recordNotApplicable(
	input: PlannerElenchusToolInput,
	elenchusDir: string,
	params: Extract<ElenchusParams, { resolution: "not_applicable" }>,
): Promise<PlannerElenchusToolResult> {
	const recordPath = join(elenchusDir, `${params.name}.not-applicable.md`);
	const content = [
		`# elenchus: not applicable — ${params.name}`,
		"",
		params.reason,
		"",
	].join("\n");
	await input.fs.writeTextAtomic(recordPath, content);
	return {
		status: "applied",
		toolName: PLANNER_ELENCHUS_TOOL_NAME,
		text: [
			"elenchus recorded as not applicable (escape).",
			`Reason: ${params.reason}`,
			`Record: ${recordPath}`,
			"",
			"The consistency step is satisfied without running the engine. Call planner_status, then planner_finish_step to continue.",
		].join("\n"),
		details: {
			resolution: "not_applicable",
			verdict: null,
			sourcePath: null,
			resultPath: recordPath,
			engineVersion: null,
		},
	};
}

function detectVerdict(output: string): string | null {
	for (const verdict of VERDICTS) {
		if (output.includes(verdict)) return verdict;
	}
	return null;
}

function normalizeProgram(program: string): string {
	const trimmed = program.replace(/\s+$/u, "");
	return `${trimmed}\n`;
}

function parseElenchusParams(value: unknown): ElenchusParams {
	const record = asObject(value);
	const name = sanitizeName(requiredString(record, "name"));
	const resolution = record.resolution;
	if (resolution === "not_applicable") {
		return {
			resolution: "not_applicable",
			name,
			reason: requiredString(record, "reason"),
		};
	}
	if (resolution === "checked" || resolution === undefined) {
		const format = record.format;
		if (format !== undefined && format !== "json" && format !== "human") {
			throw new TypeError(
				'planner_elenchus_check.format must be "json" or "human".',
			);
		}
		return {
			resolution: "checked",
			name,
			program: requiredString(record, "program"),
			format: (format as "json" | "human" | undefined) ?? "json",
			values: optionalValues(record, "values"),
		};
	}
	throw new TypeError(
		'planner_elenchus_check.resolution must be "checked" or "not_applicable".',
	);
}

function sanitizeName(value: string): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|(?<!-)-+$/g, "")
		.replace(/-+/g, "-")
		.slice(0, 64);
	if (!slug) {
		throw new TypeError(
			"planner_elenchus_check.name must contain at least one alphanumeric character.",
		);
	}
	return slug;
}

function optionalValues(
	record: Record<string, unknown>,
	key: string,
): Record<string, boolean> | undefined {
	const value = record[key];
	if (value === undefined || value === null) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(
			`planner_elenchus_check.${key} must be an object of { "port name": true|false }.`,
		);
	}
	const out: Record<string, boolean> = {};
	for (const [port, bool] of Object.entries(value)) {
		if (typeof bool !== "boolean") {
			throw new TypeError(
				`planner_elenchus_check.${key}["${port}"] must be true or false.`,
			);
		}
		out[port] = bool;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function requiredString(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError(
			`planner_elenchus_check.${key} must be a non-empty string.`,
		);
	}
	return value.trim();
}

function asObject(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError("planner_elenchus_check parameters must be an object.");
	}
	return value as Record<string, unknown>;
}

function blocked(text: string): PlannerElenchusToolResult {
	return {
		status: "blocked",
		toolName: PLANNER_ELENCHUS_TOOL_NAME,
		text,
		details: null,
	};
}
