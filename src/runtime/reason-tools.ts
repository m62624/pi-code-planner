import { join } from "node:path";
import { errorMessage } from "../errors";
import { sha256 } from "../hash";
import type { PlanStoragePaths } from "../storage/paths";
import type { PlanStateRecord } from "../storage/schema";
import { readSpecRecordIfExists } from "../storage/spec-store";
import { syncVrfTemplatesToPlan } from "../vrf/manager";
import {
	assertWorldStatements,
	retractWorldStatements,
	runWorldCheck,
	type WorldStatementInput,
	type WorldVerdict,
} from "../vrf/world-store";
import {
	type ElenchusLastCheckRecord,
	writeElenchusLastCheck,
} from "./elenchus-tools";
import {
	checkPlannerOrchestratorToolAllowed,
	runPlannerOrchestrator,
} from "./orchestrator";
import { loadStepReasoningFuel } from "./reason-context";
import { renderReasoningDirective } from "./reason-directive";
import type { PlannerToolContext } from "./tool-context";
import { blockedResult } from "./tool-result";

export const PLANNER_REASON_TOOL_NAME = "planner_reason" as const;
export type PlannerReasonToolName = typeof PLANNER_REASON_TOOL_NAME;

export interface PlannerReasonToolInput extends PlannerToolContext {
	params: unknown;
}

export interface PlannerReasonToolResult {
	status: "applied" | "blocked";
	toolName: PlannerReasonToolName;
	text: string;
	details: {
		mode: "assert" | "retract" | "recheck";
		verdict: WorldVerdict | null;
		fuel: number | null;
	} | null;
}

interface AssertStatement {
	vrf: string;
	/** Project-root-relative file to anchor this observation to (the tool hashes it). */
	anchor?: string;
}

type ReasonParams =
	| { mode: "assert"; domain: string; statements: AssertStatement[] }
	| { mode: "retract"; ids: string[] }
	| { mode: "recheck" };

/**
 * `planner_reason` — the model's handle on the living elenchus world. It never
 * hands the model a parsed report: it runs the whole world through the engine,
 * scans the verdict, and returns the raw output verbatim plus the step's
 * reasoning-fuel directive. Three modes:
 *
 *   assert  — add FACT/PREMISE/RULE/… statements to a domain, then re-check;
 *             observations may name a file to anchor to (hashed here, so stale
 *             knowledge later demotes to belief instead of a false CONFLICT).
 *   retract — remove statements by id, then re-check; always succeeds (the
 *             anti-deadlock escape).
 *   recheck — re-run the world as-is (cheap orientation).
 *
 * Gated exactly like planner_elenchus_check: allowed only where both
 * guard/tool-policy and stage-behavior list it (the six reasoning steps).
 */
export async function executePlannerReasonTool(
	input: PlannerReasonToolInput,
): Promise<PlannerReasonToolResult> {
	try {
		const orchestrator = await runPlannerOrchestrator(input);
		if (orchestrator.preflight.context.status !== "ready") {
			return blocked(orchestrator.preflight.context.reason);
		}
		const policy = checkPlannerOrchestratorToolAllowed({
			orchestrator,
			toolName: PLANNER_REASON_TOOL_NAME,
		});
		if (!policy.allow) {
			return blocked(
				policy.reason ?? "planner_reason is blocked by planner state.",
			);
		}

		const { planPaths, state } = orchestrator.preflight.context;
		const params = parseReasonParams(input.params);

		// The spec template must resolve when the world compiles the spec layer.
		await syncVrfTemplatesToPlan(input.fs, {
			projectPaths: input.projectPaths,
			planPaths,
		});

		if (params.mode === "assert") {
			const inputs = await buildAssertInputs(input, state, params);
			// Validates every statement up front; a bad one throws → blocked, and
			// nothing is written (all-or-nothing).
			await assertWorldStatements(input.fs, planPaths, inputs);
		} else if (params.mode === "retract") {
			const { removed, missing } = await retractWorldStatements(
				input.fs,
				planPaths,
				params.ids,
			);
			if (removed.length === 0 && missing.length > 0) {
				// Still re-check below, but tell the model none of its ids matched.
				return await finishRun(input, planPaths, state, params.mode, {
					note: `No statements matched ${missing.join(", ")}. Nothing was retracted.`,
				});
			}
		}

		return await finishRun(input, planPaths, state, params.mode, {});
	} catch (error) {
		return blocked(errorMessage(error));
	}
}

async function finishRun(
	input: PlannerReasonToolInput,
	planPaths: PlanStoragePaths,
	state: PlanStateRecord,
	mode: ReasonParams["mode"],
	opts: { note?: string },
): Promise<PlannerReasonToolResult> {
	const elenchusDir = planPaths.elenchusDir;

	const spec = await readSpecRecordIfExists(input.fs, planPaths);
	const run = await runWorldCheck(input.fs, planPaths, {
		spec,
		hashProjectFile: (path) => hashProjectFile(input, path),
	});
	if (!run.ok) return blocked(run.reason);

	const record: ElenchusLastCheckRecord = {
		name: "world",
		stage: state.stage,
		step: state.step,
		outcome: run.verdict,
		recordedAt: new Date().toISOString(),
	};
	await writeElenchusLastCheck(input.fs, elenchusDir, record);

	const { fuel, webNoun } = await loadStepReasoningFuel({
		fs: input.fs,
		planPaths,
		state,
		stale: run.compiled.demoted.length,
		lastCheck: record,
	});
	const directive = renderReasoningDirective(fuel, {
		webNoun,
		reasonTool: PLANNER_REASON_TOOL_NAME,
	});

	const consistent = run.verdict === "CONSISTENT";
	const text = [
		`planner_reason ${mode} → world verdict: ${run.verdict} (${run.engineVersion}).`,
		...(opts.note ? [opts.note] : []),
		// The raw engine report is only actionable when NOT consistent (it names
		// the FACT/NOT to add or the conflict to fix). On CONSISTENT it is a big
		// non-actionable derived[] dump, so withhold it — the verdict line says all
		// there is. Never parsed (anti-Fable-5), just not shown.
		...(consistent ? [] : ["", run.output]),
		"",
		consistent
			? "CONSISTENT: the whole living world holds. Record the conclusion, then continue."
			: run.verdict === "CONFLICT"
				? "CONFLICT: a proven contradiction in the world. planner_finish_step stays blocked for this step until a re-run improves the verdict. Apply the drop/flip the output names, or retract the wrong statement — never delete a valid premise to force green — then re-check."
				: "Not CONSISTENT yet. Read the output: assert the FACT/NOT it names, pin down an UNDERDETERMINED atom, or fix the wrong statement — then re-check.",
		...(directive ? ["", directive] : []),
		"",
		"Call planner_status before choosing the next planner action.",
	].join("\n");

	return {
		status: "applied",
		toolName: PLANNER_REASON_TOOL_NAME,
		text,
		details: { mode, verdict: run.verdict, fuel: fuel.fuel },
	};
}

async function buildAssertInputs(
	input: PlannerReasonToolInput,
	state: { stage: string; step: string },
	params: Extract<ReasonParams, { mode: "assert" }>,
): Promise<WorldStatementInput[]> {
	const origin = { stage: state.stage, step: state.step };
	const inputs: WorldStatementInput[] = [];
	for (const statement of params.statements) {
		const lines = statement.vrf.split("\n");
		const base: WorldStatementInput = {
			lines,
			domain: params.domain,
			origin,
		};
		if (statement.anchor) {
			const hash = await hashProjectFile(input, statement.anchor);
			if (hash === null) {
				throw new Error(
					`Cannot anchor to "${statement.anchor}": no such file under the project root. Assert the observation without an anchor, or fix the path.`,
				);
			}
			inputs.push({ ...base, anchor: { path: statement.anchor, hash } });
		} else {
			inputs.push(base);
		}
	}
	return inputs;
}

/** sha256 of a project-root-relative file, or null when it does not exist. */
async function hashProjectFile(
	input: PlannerReasonToolInput,
	path: string,
): Promise<string | null> {
	const absolute = join(input.projectPaths.projectRoot, path);
	if (!(await input.fs.exists(absolute))) return null;
	try {
		return sha256(await input.fs.readText(absolute));
	} catch {
		return null;
	}
}

function parseReasonParams(value: unknown): ReasonParams {
	const record = asObject(value);
	const mode = record.mode;
	if (mode === "assert") {
		return {
			mode: "assert",
			domain: requiredString(record, "domain"),
			statements: parseStatements(record.statements),
		};
	}
	if (mode === "retract") {
		return { mode: "retract", ids: parseIds(record.ids) };
	}
	if (mode === "recheck") {
		return { mode: "recheck" };
	}
	throw new TypeError(
		'planner_reason.mode must be "assert", "retract", or "recheck".',
	);
}

function parseStatements(value: unknown): AssertStatement[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new TypeError(
			"planner_reason.statements must be a non-empty array when mode=assert.",
		);
	}
	return value.map((entry, index) => {
		const record = asObject(entry, `statements[${index}]`);
		const vrf = record.vrf;
		if (typeof vrf !== "string" || vrf.trim().length === 0) {
			throw new TypeError(
				`planner_reason.statements[${index}].vrf must be a non-empty .vrf string.`,
			);
		}
		const anchor = record.anchor;
		if (anchor !== undefined && typeof anchor !== "string") {
			throw new TypeError(
				`planner_reason.statements[${index}].anchor must be a project-root-relative file path.`,
			);
		}
		return anchor ? { vrf, anchor } : { vrf };
	});
}

function parseIds(value: unknown): string[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new TypeError(
			"planner_reason.ids must be a non-empty array of statement ids when mode=retract.",
		);
	}
	return value.map((id, index) => {
		if (typeof id !== "string" || id.trim().length === 0) {
			throw new TypeError(
				`planner_reason.ids[${index}] must be a non-empty statement id (e.g. "w3").`,
			);
		}
		return id.trim();
	});
}

function requiredString(record: Record<string, unknown>, key: string): string {
	const value = record[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError(`planner_reason.${key} must be a non-empty string.`);
	}
	return value.trim();
}

function asObject(
	value: unknown,
	where = "parameters",
): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`planner_reason ${where} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function blocked(text: string): PlannerReasonToolResult {
	return blockedResult(PLANNER_REASON_TOOL_NAME, text);
}
