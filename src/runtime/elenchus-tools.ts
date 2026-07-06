import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { errorMessage } from "../errors";
import { isPathInsideOrEqual } from "../path-utils";
import { readTaskBehaviorsIfExists } from "../storage/behavior-store";
import type { PlanStoragePaths } from "../storage/paths";
import { createTaskStoragePaths } from "../storage/paths";
import type { PlanStateRecord } from "../storage/schema";
import { syncVrfTemplatesToPlan } from "../vrf/manager";
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
 * The last elenchus outcome, recorded per plan so the workflow guard can
 * refuse to finish a step whose latest check proved a CONFLICT. Every tool
 * call overwrites it: a later CONSISTENT/WARNING/not_applicable clears a
 * previous CONFLICT.
 */
export interface ElenchusLastCheckRecord {
	name: string;
	stage: string;
	step: string;
	outcome:
		| "CONSISTENT"
		| "WARNING"
		| "UNDERDETERMINED"
		| "CONFLICT"
		| "not_applicable"
		| "unknown";
	recordedAt: string;
	/**
	 * Set when the check was a planner_gate_check run (compiler-generated
	 * program). Gate steps require their gate's latest run to be CONSISTENT,
	 * which is stricter than the generic CONFLICT-only block above.
	 */
	gate?: string;
	/** sha256 of the compiled source artifact (e.g. spec.json), so a gate pass
	 * is invalidated when the artifact changes after the check. */
	sourceHash?: string;
}

const LAST_CHECK_FILE = "last-check.json";

export async function readElenchusLastCheck(
	fs: PlannerToolContext["fs"],
	elenchusDir: string,
): Promise<ElenchusLastCheckRecord | null> {
	const path = join(elenchusDir, LAST_CHECK_FILE);
	if (!(await fs.exists(path))) return null;
	try {
		const parsed = JSON.parse(await fs.readText(path)) as unknown;
		if (!parsed || typeof parsed !== "object") return null;
		return parsed as ElenchusLastCheckRecord;
	} catch {
		return null;
	}
}

export async function writeElenchusLastCheck(
	fs: PlannerToolContext["fs"],
	elenchusDir: string,
	record: ElenchusLastCheckRecord,
): Promise<void> {
	await fs.writeTextAtomic(
		join(elenchusDir, LAST_CHECK_FILE),
		`${JSON.stringify(record, null, "\t")}\n`,
	);
}

/**
 * Run the bundled elenchus engine on a model-authored `.vrf` program, or record
 * a terminal `not_applicable` escape. The escape — mirroring doubt_review's
 * `not_a_bug` — is what keeps any step that nudges toward elenchus from ever
 * deadlocking: a plan with no interacting-constraint web resolves the step in
 * one call with a reason, without running the engine.
 *
 * Gating is generic: the orchestrator allows this tool only at the steps where
 * both guard/tool-policy and stage-behavior list it (the discovery scan,
 * planning/consistency_check, execution/write_tdd_plan, execution/contract_check,
 * finalize/doubt_review, and recovery/repair_or_resume).
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

		const { planPaths, state } = orchestrator.preflight.context;
		const elenchusDir = planPaths.elenchusDir;
		const position = { stage: state.stage, step: state.step };
		const params = parseElenchusParams(input.params);

		// The branch-contract and the tdd_coverage gate share ONE source of truth:
		// the active task's declared branches[]. If the task decomposed its logic
		// into branches for coverage, the logical contract cannot pretend the task
		// has none — so a not_applicable escape is refused and every declared branch
		// must be reasoned about in a `checked` program (see loadActiveTaskBranches).
		const declaredBranches = await loadActiveTaskBranches(
			input.fs,
			planPaths,
			state,
		);

		if (params.resolution === "not_applicable") {
			if (declaredBranches) {
				return blocked(branchyEscapeBlockedMessage(declaredBranches));
			}
			return await recordNotApplicable(input, elenchusDir, position, params);
		}

		if (declaredBranches) {
			const missing = declaredBranches.branches.filter(
				(b) => !programMentionsBranch(params.program, b.id),
			);
			if (missing.length > 0) {
				return blocked(missingBranchBlockedMessage(declaredBranches, missing));
			}
		}
		// Materialize the premise-template library before every check so a
		// program's `IMPORT "templates/<name>.vrf"` always resolves, stays inside
		// the sandbox, and picks up project overrides. Hash-compared: idempotent.
		await syncVrfTemplatesToPlan(input.fs, {
			projectPaths: input.projectPaths,
			planPaths,
		});
		return await runCheck(input, elenchusDir, position, params);
	} catch (error) {
		return blocked(errorMessage(error));
	}
}

async function runCheck(
	input: PlannerElenchusToolInput,
	elenchusDir: string,
	position: { stage: string; step: string },
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
	await writeElenchusLastCheck(input.fs, elenchusDir, {
		name: params.name,
		stage: position.stage,
		step: position.step,
		outcome: (verdict as ElenchusLastCheckRecord["outcome"]) ?? "unknown",
		recordedAt: new Date().toISOString(),
	});
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
				: verdict === "CONFLICT"
					? "CONFLICT: a proven contradiction. planner_finish_step is blocked for this step until a re-run improves the verdict (or records not_applicable). Apply the drop/flip repair the CORE/RETRACT names — fix the plan or the wrong fact, never delete a valid premise to force green — then call planner_elenchus_check again."
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
	position: { stage: string; step: string },
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
	await writeElenchusLastCheck(input.fs, elenchusDir, {
		name: params.name,
		stage: position.stage,
		step: position.step,
		outcome: "not_applicable",
		recordedAt: new Date().toISOString(),
	});
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

interface DeclaredBranches {
	taskId: string;
	branches: { id: string; condition: string }[];
}

/**
 * The active task's declared branches, flattened across its behaviors, or null
 * when there is no active task, no behavior board yet, or the board declares no
 * branches at all. A non-null result means the task mechanically decomposed its
 * logic into branches for the tdd_coverage gate — so the logical branch-contract
 * must reason about the SAME branches (it cannot be `not_applicable`, and a
 * `checked` program must mention each one).
 */
async function loadActiveTaskBranches(
	fs: PlannerToolContext["fs"],
	planPaths: PlanStoragePaths,
	state: PlanStateRecord,
): Promise<DeclaredBranches | null> {
	const taskId = state.activeTaskId;
	if (!taskId) return null;
	const taskPaths = createTaskStoragePaths(planPaths, taskId);
	const record = await readTaskBehaviorsIfExists(fs, taskPaths);
	if (!record) return null;
	const branches = record.behaviors.flatMap((behavior) =>
		behavior.branches.map((branch) => ({
			id: branch.id,
			condition: branch.condition,
		})),
	);
	if (branches.length === 0) return null;
	return { taskId, branches };
}

/**
 * Whether the program reasons about a declared branch. elenchus identifiers
 * cannot contain a hyphen, so `BR-1` is transliterated in the program (e.g.
 * `br_1`, `BR_1`, or a domain-prefixed `x.br_1`). We match the branch *number*
 * after a `br` prefix with an optional `-`/`_`/space separator, bounded so `br_1`
 * does not falsely match `br_10`. The convention (execution.md) is that each
 * branch's contract subject carries its number, e.g. `br_1` for `BR-1`.
 */
function programMentionsBranch(program: string, branchId: string): boolean {
	const num = branchId.replace(/^BR-/, "");
	return new RegExp(`\\bbr[-_ ]?${num}\\b`, "i").test(program);
}

function branchyEscapeBlockedMessage(declared: DeclaredBranches): string {
	const list = declared.branches.map((b) => `${b.id} (${b.condition})`);
	return [
		`Task ${declared.taskId} declares ${declared.branches.length} branch(es) in its behavior board:`,
		...list.map((line) => `  - ${line}`),
		"",
		"The logical branch-contract cannot be not_applicable — the task's own",
		"coverage decomposition proves it has branching logic. Run the engine",
		"instead: resolution=checked, modeling each branch above as a subject",
		"carrying its number (e.g. br_1 for BR-1 — elenchus ids take no hyphen),",
		"with the premises that must hold across them.",
	].join("\n");
}

function missingBranchBlockedMessage(
	declared: DeclaredBranches,
	missing: { id: string; condition: string }[],
): string {
	const list = missing.map((b) => `  - ${b.id} (${b.condition})`);
	return [
		`Branch-contract for ${declared.taskId} is incomplete: these declared`,
		"branches are covered for tests but not reasoned about in the program:",
		...list,
		"",
		"Add each missing branch as a subject carrying its number (e.g. br_1 for",
		"BR-1) so the tdd_coverage board and the logical contract share one branch",
		"set, then call planner_elenchus_check again.",
	].join("\n");
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
