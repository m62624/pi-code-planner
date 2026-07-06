import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { errorMessage } from "../errors";
import type { GitRunner } from "../git/runner";
import { isPathInsideOrEqual } from "../path-utils";
import { readTaskBehaviorsIfExists } from "../storage/behavior-store";
import type { PlannerFs } from "../storage/fs";
import {
	createTaskStoragePaths,
	type PlanStoragePaths,
	type ProjectStoragePaths,
} from "../storage/paths";
import { readPlanRecord } from "../storage/plan-store";
import type { TaskRecord } from "../storage/schema";
import { readSpecRecordIfExists, type SpecRecord } from "../storage/spec-store";
import { readTaskRecord } from "../storage/task-store";
import { compilePlanCoverage } from "../vrf/coverage-compiler";
import { syncVrfTemplatesToPlan } from "../vrf/manager";
import {
	compileSpecConsistency,
	specSubjectToRequirementId,
} from "../vrf/spec-compiler";
import {
	compileTddCoverage,
	type TddCoveragePhase,
} from "../vrf/tdd-coverage-compiler";
import { runElenchusCheck } from "./elenchus-engine";
import { writeElenchusLastCheck } from "./elenchus-tools";
import {
	checkPlannerOrchestratorToolAllowed,
	runPlannerOrchestrator,
} from "./orchestrator";

export const PLANNER_GATE_TOOL_NAME = "planner_gate_check" as const;
export type PlannerGateToolName = typeof PLANNER_GATE_TOOL_NAME;

export const PLANNER_GATE_NAMES = [
	"spec_consistency",
	"plan_coverage",
	"tdd_coverage",
] as const;
export type PlannerGateName = (typeof PLANNER_GATE_NAMES)[number];

export interface PlannerGateToolResult {
	status: "applied" | "blocked";
	toolName: PlannerGateToolName;
	text: string;
	details: {
		gate: PlannerGateName;
		verdict: string;
		sourcePath: string;
		resultPath: string;
		gaps: string[];
	} | null;
}

/**
 * The SDD gate runner (REQ-4/REQ-6/REQ-12): loads the durable artifacts from
 * disk, compiles them into VRF with a deterministic compiler, runs the
 * elenchus engine, and turns every reported gap into a concrete instruction
 * or a ready-to-ask user question. The model supplies NO program — trivial
 * hand-written gate VRF is structurally impossible here.
 */
export async function executePlannerGateTool(input: {
	fs: PlannerFs;
	git: GitRunner;
	projectPaths: ProjectStoragePaths;
	params: unknown;
}): Promise<PlannerGateToolResult> {
	try {
		const orchestrator = await runPlannerOrchestrator(input);
		if (orchestrator.preflight.context.status !== "ready") {
			return blocked(orchestrator.preflight.context.reason);
		}
		const policy = checkPlannerOrchestratorToolAllowed({
			orchestrator,
			toolName: PLANNER_GATE_TOOL_NAME,
		});
		if (!policy.allow) {
			return blocked(
				policy.reason ?? "planner_gate_check is blocked by planner state.",
			);
		}
		const gate = parseGateName(input.params);
		const { planPaths, state } = orchestrator.preflight.context;
		await syncVrfTemplatesToPlan(input.fs, {
			projectPaths: input.projectPaths,
			planPaths,
		});
		switch (gate) {
			case "spec_consistency":
				return await runSpecConsistencyGate({
					fs: input.fs,
					planPaths,
					position: { stage: state.stage, step: state.step },
				});
			case "plan_coverage":
				return await runPlanCoverageGate({
					fs: input.fs,
					planPaths,
					position: { stage: state.stage, step: state.step },
				});
			case "tdd_coverage":
				return await runTddCoverageGate({
					fs: input.fs,
					planPaths,
					activeTaskId: state.activeTaskId,
					position: { stage: state.stage, step: state.step },
				});
		}
	} catch (error) {
		return blocked(errorMessage(error));
	}
}

async function runSpecConsistencyGate(input: {
	fs: PlannerFs;
	planPaths: PlanStoragePaths;
	position: { stage: string; step: string };
}): Promise<PlannerGateToolResult> {
	const spec = await readSpecRecordIfExists(input.fs, input.planPaths);
	if (!spec) {
		return blocked(
			"spec.json does not exist for this plan. Author the spec first with planner_spec_submit at spec/draft_requirements.",
		);
	}
	const compiled = compileSpecConsistency(spec);
	const run = await runGateProgram({
		fs: input.fs,
		planPaths: input.planPaths,
		gate: "spec_consistency",
		fileStem: "spec-consistency",
		program: compiled.program,
		values: compiled.values,
		position: input.position,
		sourceHash: sha256(await input.fs.readText(input.planPaths.specJson)),
	});
	if (!run.ok) return blocked(run.reason);

	const gaps = describeSpecGaps(run.report);
	const consistent = run.verdict === "CONSISTENT";
	await writeCoverageSection(input.fs, input.planPaths, {
		heading: "## Spec Consistency",
		lines: [
			`Verdict: **${run.verdict}** (engine ${run.engineVersion}, ${new Date().toISOString()})`,
			`Requirements compiled: ${compiled.requirementCount}`,
			"",
			...(gaps.length > 0
				? ["Gaps:", ...gaps.map((gap) => `- ${gap}`)]
				: [
						"No gaps — every in-scope requirement is addressed and the constraint web is consistent.",
					]),
		],
	});

	return {
		status: "applied",
		toolName: PLANNER_GATE_TOOL_NAME,
		text: [
			`spec_consistency gate: **${run.verdict}** (engine ${run.engineVersion}).`,
			`Compiled program: ${run.sourcePath}`,
			`Raw verdict: ${run.resultPath}`,
			`Coverage report: ${input.planPaths.coverageMd}`,
			"",
			...(gaps.length > 0
				? ["Gaps to close:", ...gaps.map((gap) => `- ${gap}`), ""]
				: []),
			consistent
				? "CONSISTENT: the spec's requirement web holds. Record the conclusion in decisions.md, then call planner_finish_step."
				: "Not CONSISTENT: spec/verify_spec cannot finish yet. Close each gap above — update the spec via planner_spec_submit, or route a question to the user via spec/elicit_gaps — then re-run planner_gate_check.",
		].join("\n"),
		details: {
			gate: "spec_consistency",
			verdict: run.verdict,
			sourcePath: run.sourcePath,
			resultPath: run.resultPath,
			gaps,
		},
	};
}

async function runPlanCoverageGate(input: {
	fs: PlannerFs;
	planPaths: PlanStoragePaths;
	position: { stage: string; step: string };
}): Promise<PlannerGateToolResult> {
	const spec = await readSpecRecordIfExists(input.fs, input.planPaths);
	if (!spec) {
		// Legacy plan (predates the spec artifact): coverage degrades gracefully
		// (REQ-11) — the old plan-consistency flow still applies at this step.
		await writeElenchusLastCheck(input.fs, input.planPaths.elenchusDir, {
			name: "plan-coverage",
			stage: input.position.stage,
			step: input.position.step,
			outcome: "not_applicable",
			recordedAt: new Date().toISOString(),
			gate: "plan_coverage",
		});
		await writeCoverageSection(input.fs, input.planPaths, {
			heading: "## Requirement Coverage",
			lines: [
				"Skipped: this plan has no spec.json (it predates the SDD spec layer).",
				"The legacy plan-consistency check applies instead.",
			],
		});
		return {
			status: "applied",
			toolName: PLANNER_GATE_TOOL_NAME,
			text: "plan_coverage gate skipped: no spec.json (legacy plan). Run the legacy plan-consistency check via planner_elenchus_check instead.",
			details: {
				gate: "plan_coverage",
				verdict: "not_applicable",
				sourcePath: "",
				resultPath: "",
				gaps: [],
			},
		};
	}
	const tasks = await readAllTaskRecords(input.fs, input.planPaths);
	if (tasks.length === 0) {
		return blocked(
			"No task files exist yet — author them at planning/write_task_files (planner_task_upsert with a `requirements` list per task) before running the plan_coverage gate.",
		);
	}
	const compiled = compilePlanCoverage(spec, tasks);
	if (compiled.unknownRequirementRefs.length > 0) {
		return blocked(
			[
				"Some tasks cite requirement ids that do not exist in spec.json:",
				...compiled.unknownRequirementRefs.map(
					(ref) => `- task ${ref.taskId} → ${ref.requirement}`,
				),
				"Fix the task via planner_task_upsert (exact REQ-n ids), or add the requirement to the spec and re-verify it.",
			].join("\n"),
		);
	}
	const run = await runGateProgram({
		fs: input.fs,
		planPaths: input.planPaths,
		gate: "plan_coverage",
		fileStem: "plan-coverage",
		program: compiled.program,
		values: {},
		position: input.position,
		sourceHash: await planCoverageSourceHash(input.fs, input.planPaths, tasks),
	});
	if (!run.ok) return blocked(run.reason);

	const gaps = describeCoverageGaps(run.report, compiled.taskSubjects);
	const consistent = run.verdict === "CONSISTENT";
	await writeCoverageSection(input.fs, input.planPaths, {
		heading: "## Requirement Coverage",
		lines: [
			`Verdict: **${run.verdict}** (engine ${run.engineVersion}, ${new Date().toISOString()})`,
			`Coverable requirements: ${compiled.requirementCount}, tasks: ${compiled.taskCount}`,
			"",
			...(gaps.length > 0
				? ["Gaps:", ...gaps.map((gap) => `- ${gap}`)]
				: [
						"No gaps — every in-scope requirement is covered by a task and every task traces to a requirement.",
					]),
		],
	});
	return {
		status: "applied",
		toolName: PLANNER_GATE_TOOL_NAME,
		text: [
			`plan_coverage gate: **${run.verdict}** (engine ${run.engineVersion}).`,
			`Compiled program: ${run.sourcePath}`,
			`Raw verdict: ${run.resultPath}`,
			`Coverage report: ${input.planPaths.coverageMd}`,
			"",
			...(gaps.length > 0
				? ["Gaps to close:", ...gaps.map((gap) => `- ${gap}`), ""]
				: []),
			consistent
				? "CONSISTENT: every in-scope requirement is discharged and no task is orphan work. Record the conclusion in decisions.md, then call planner_finish_step."
				: "Not CONSISTENT: the plan drops a requirement or carries orphan work. Fix the tasks (planner_task_upsert with the right `requirements`), or de-scope a requirement through a recorded user decision, then re-run planner_gate_check.",
		].join("\n"),
		details: {
			gate: "plan_coverage",
			verdict: run.verdict,
			sourcePath: run.sourcePath,
			resultPath: run.resultPath,
			gaps,
		},
	};
}

/**
 * The REQ-n ids this task both declares (task.requirements) and the spec still
 * counts as coverable (in-scope, not deferred through the freedom valve). These
 * are the requirements a behavior must exercise; anything else the task cites is
 * out of scope for the coverage totality.
 */
async function readOwnedRequirements(
	fs: PlannerFs,
	taskPaths: ReturnType<typeof createTaskStoragePaths>,
	spec: SpecRecord,
): Promise<string[]> {
	const task = await readTaskRecord(fs, taskPaths);
	const coverable = new Set(
		spec.requirements
			.filter((req) => req.inScope && req.deferral === undefined)
			.map((req) => req.id),
	);
	return [...new Set(task.requirements ?? [])].filter((id) =>
		coverable.has(id),
	);
}

async function readAllTaskRecords(
	fs: PlannerFs,
	planPaths: PlanStoragePaths,
): Promise<TaskRecord[]> {
	const plan = await readPlanRecord(fs, planPaths);
	const records: TaskRecord[] = [];
	for (const summary of plan.tasks) {
		records.push(
			await readTaskRecord(
				fs,
				createTaskStoragePaths(planPaths, summary.taskId),
			),
		);
	}
	return records;
}

/**
 * The coverage verdict depends on spec.json AND on every task's requirements
 * list — editing either after a pass makes the pass stale.
 */
export async function planCoverageSourceHash(
	fs: PlannerFs,
	planPaths: PlanStoragePaths,
	tasks: readonly TaskRecord[],
): Promise<string> {
	const traceability = [...tasks]
		.sort((a, b) => a.taskId.localeCompare(b.taskId))
		.map((task) => [task.taskId, [...(task.requirements ?? [])].sort()]);
	return sha256(
		`${await fs.readText(planPaths.specJson)}\n${JSON.stringify(traceability)}`,
	);
}

function describeCoverageGaps(
	report: ElenchusJsonReport,
	taskSubjects: Record<string, string>,
): string[] {
	const gaps: string[] = [];
	for (const warning of report.warnings ?? []) {
		for (const blocked of warning.blocked_by ?? []) {
			const subject = blocked.split(" ")[0] ?? blocked;
			if (blocked.includes("no covered_by witness")) {
				gaps.push(
					`${specSubjectToRequirementId(subject)} is DROPPED — no task discharges it. Add it to a task's \`requirements\` via planner_task_upsert, or de-scope it through a recorded user decision.`,
				);
			} else if (blocked.includes("no traces witness")) {
				gaps.push(
					`Task "${taskSubjects[subject] ?? subject}" is ORPHAN work — it traces to no requirement. Cite the REQ-n it discharges via planner_task_upsert, or remove/merge the task.`,
				);
			} else {
				gaps.push(`Blocked by \`${blocked}\`.`);
			}
		}
	}
	return gaps;
}

async function runTddCoverageGate(input: {
	fs: PlannerFs;
	planPaths: PlanStoragePaths;
	activeTaskId: string | null;
	position: { stage: string; step: string };
}): Promise<PlannerGateToolResult> {
	if (!input.activeTaskId) {
		return blocked(
			"No active task — the tdd_coverage gate checks the behavior board of the task being executed. Select a task first (execution/prepare_task).",
		);
	}
	const taskPaths = createTaskStoragePaths(input.planPaths, input.activeTaskId);
	const behaviors = await readTaskBehaviorsIfExists(input.fs, taskPaths);
	if (!behaviors) {
		return blocked(
			`tasks/${input.activeTaskId}/behaviors.json does not exist. Enumerate the task's behaviors first with planner_behavior_upsert (at execution/write_tdd_plan), then re-run this gate.`,
		);
	}
	// When the plan has a spec, bind behaviors to the requirements this task
	// owns so a REQ with no behavior is NAMED (legacy plans without a spec keep
	// behavior-only coverage — REQ-11 graceful degradation).
	const spec = await readSpecRecordIfExists(input.fs, input.planPaths);
	const ownedRequirements = spec
		? await readOwnedRequirements(input.fs, taskPaths, spec)
		: [];
	// run_final_tests demands green witnesses; every earlier step checks red.
	const phase: TddCoveragePhase =
		input.position.step === "run_final_tests" ? "green" : "red";
	const compiled = compileTddCoverage(behaviors, phase, { ownedRequirements });
	if (compiled.unknownRequirementRefs.length > 0) {
		return blocked(
			[
				"Some behaviors cite a requirement this task does not own (task.requirements):",
				...compiled.unknownRequirementRefs.map(
					(ref) => `- ${ref.behaviorId} → ${ref.requirement}`,
				),
				"Cite an owned REQ-n via planner_behavior_upsert, or add the requirement to this task at planning (planner_task_upsert).",
			].join("\n"),
		);
	}
	const run = await runGateProgram({
		fs: input.fs,
		planPaths: input.planPaths,
		gate: "tdd_coverage",
		fileStem: `tdd-coverage-${phase}`,
		program: compiled.program,
		values: {},
		position: input.position,
		sourceHash: sha256(await input.fs.readText(taskPaths.behaviorsJson)),
	});
	if (!run.ok) return blocked(run.reason);

	const gaps = describeTddGaps(
		run.report,
		compiled.behaviorSubjects,
		compiled.branchSubjects,
	);
	const consistent = run.verdict === "CONSISTENT";
	await writeCoverageSection(input.fs, input.planPaths, {
		heading: `## Test Coverage — ${input.activeTaskId}`,
		lines: [
			`Phase: ${phase} — Verdict: **${run.verdict}** (engine ${run.engineVersion}, ${new Date().toISOString()})`,
			`Behaviors: ${compiled.behaviorCount}${compiled.requirementCount > 0 ? `, owned requirements: ${compiled.requirementCount}` : ""}${compiled.branchCount > 0 ? `, branches: ${compiled.branchCount}` : ""}`,
			"",
			...(gaps.length > 0
				? ["Uncovered:", ...gaps.map((gap) => `- ${gap}`)]
				: [
						`No holes — every behavior has its ${phase === "green" ? "red AND green" : "red"} witness.`,
					]),
		],
	});
	return {
		status: "applied",
		toolName: PLANNER_GATE_TOOL_NAME,
		text: [
			`tdd_coverage gate (${phase}) for ${input.activeTaskId}: **${run.verdict}** (engine ${run.engineVersion}).`,
			`Compiled program: ${run.sourcePath}`,
			`Raw verdict: ${run.resultPath}`,
			"",
			...(gaps.length > 0
				? [
						"The machine counts these behaviors as uncovered:",
						...gaps.map((gap) => `- ${gap}`),
						"",
					]
				: []),
			consistent
				? `CONSISTENT: every behavior has its ${phase} witness. Call planner_finish_step.`
				: phase === "red"
					? "Not CONSISTENT: write the missing failing test(s), flip each behavior planned→red via planner_behavior_upsert (with the test file+name), and re-run this gate."
					: "Not CONSISTENT: make the named tests pass, flip each behavior red→green via planner_behavior_upsert, and re-run this gate.",
		].join("\n"),
		details: {
			gate: "tdd_coverage",
			verdict: run.verdict,
			sourcePath: run.sourcePath,
			resultPath: run.resultPath,
			gaps,
		},
	};
}

function describeTddGaps(
	report: ElenchusJsonReport,
	behaviorSubjects: Record<string, string>,
	branchSubjects: Record<
		string,
		{ behaviorId: string; branchId: string; condition: string }
	>,
): string[] {
	const gaps: string[] = [];
	for (const warning of report.warnings ?? []) {
		for (const blocked of warning.blocked_by ?? []) {
			const subject = blocked.split(" ")[0] ?? blocked;
			const id = behaviorSubjects[subject] ?? subject;
			if (blocked.includes("no has_red_test witness")) {
				gaps.push(`${id}: no failing test yet (needs a named red witness).`);
			} else if (blocked.includes("no has_green_test witness")) {
				gaps.push(`${id}: its test does not pass yet (needs a green witness).`);
			} else if (blocked.includes("no covered_by witness")) {
				gaps.push(
					`${specSubjectToRequirementId(subject)} is discharged by this task but NO behavior exercises it — add a behavior citing it via planner_behavior_upsert.`,
				);
			} else {
				gaps.push(`Blocked by \`${blocked}\`.`);
			}
		}
	}
	// Per-branch holes come back as CONFLICTs (the compiler states every branch
	// value explicitly): name each uncovered branch by its behavior + condition.
	const seenBranches = new Set<string>();
	for (const conflict of report.conflicts ?? []) {
		for (const atom of conflict.atoms ?? []) {
			const subject = atomSubject(atom);
			const branch = branchSubjects[subject];
			if (!branch || seenBranches.has(subject)) continue;
			seenBranches.add(subject);
			const missing = atom.includes("has_green")
				? "its test does not pass yet (green)"
				: "no failing test drives it yet (red)";
			gaps.push(
				`${branch.behaviorId}/${branch.branchId} "${branch.condition}": ${missing}.`,
			);
		}
	}
	return gaps;
}

// ---------------------------------------------------------------------------
// shared gate plumbing
// ---------------------------------------------------------------------------

interface ElenchusJsonReport {
	status?: string;
	warnings?: Array<{
		premise?: string;
		blocked_by?: string[];
		hint?: string;
	}>;
	conflicts?: Array<{
		atoms?: string[];
		premise?: string;
		origin?: { premise?: string };
	}>;
	underdetermined?: string | null;
	goals?: Array<{ label?: string; outcome?: string }>;
}

type GateRun =
	| {
			ok: true;
			verdict: string;
			report: ElenchusJsonReport;
			sourcePath: string;
			resultPath: string;
			engineVersion: string;
	  }
	| { ok: false; reason: string };

async function runGateProgram(input: {
	fs: PlannerFs;
	planPaths: PlanStoragePaths;
	gate: PlannerGateName;
	fileStem: string;
	program: string;
	values: Record<string, boolean>;
	position: { stage: string; step: string };
	sourceHash: string;
}): Promise<GateRun> {
	const elenchusDir = input.planPaths.elenchusDir;
	const sourceName = `${input.fileStem}.vrf`;
	const sourcePath = join(elenchusDir, sourceName);
	await input.fs.writeTextAtomic(sourcePath, input.program);

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
		format: "json",
		values: input.values,
	});
	if (!run.ok) return { ok: false, reason: run.reason };

	let report: ElenchusJsonReport;
	try {
		report = JSON.parse(run.output) as ElenchusJsonReport;
	} catch {
		// Parse/compile errors and budget aborts come back as a plain error
		// string instead of a JSON verdict. A deterministic compiler should
		// never produce one — surface it verbatim as a bug signal.
		return {
			ok: false,
			reason: `The compiled gate program did not produce a verdict (this is a compiler bug, not a spec problem): ${run.output.trim()}`,
		};
	}
	const verdict = report.status ?? "unknown";
	const resultPath = join(elenchusDir, `${input.fileStem}.result.json`);
	await input.fs.writeTextAtomic(resultPath, `${run.output.trim()}\n`);
	await writeElenchusLastCheck(input.fs, elenchusDir, {
		name: input.fileStem,
		stage: input.position.stage,
		step: input.position.step,
		outcome: normalizeVerdict(verdict),
		recordedAt: new Date().toISOString(),
		gate: input.gate,
		sourceHash: input.sourceHash,
	});
	return {
		ok: true,
		verdict,
		report,
		sourcePath,
		resultPath,
		engineVersion: run.engineVersion,
	};
}

function normalizeVerdict(
	verdict: string,
): "CONSISTENT" | "WARNING" | "UNDERDETERMINED" | "CONFLICT" | "unknown" {
	switch (verdict) {
		case "CONSISTENT":
		case "WARNING":
		case "UNDERDETERMINED":
		case "CONFLICT":
			return verdict;
		default:
			return "unknown";
	}
}

/** Turn the engine's machine-readable gaps into concrete next actions. */
function describeSpecGaps(report: ElenchusJsonReport): string[] {
	const gaps: string[] = [];
	for (const conflict of report.conflicts ?? []) {
		const atoms = conflict.atoms ?? [];
		const premise = conflict.premise ?? conflict.origin?.premise ?? "";
		const requirement = atoms
			.map(atomSubject)
			.map(specSubjectToRequirementId)
			.find((id) => id.startsWith("REQ-"));
		if (premise === "no_fake_formal" && requirement) {
			gaps.push(
				`CONFLICT: ${requirement} is marked formalized but is not VRF-expressible — a formalized requirement must be genuinely checkable. Either give it a real acceptanceAtom or defer it with deferral.rationale.`,
			);
		} else {
			gaps.push(
				`CONFLICT (${premise || "constraint"}): ${atoms.join(", ")} — these facts contradict each other. Fix the spec (a requirement, constraint relation, or assumption is wrong); never delete a valid premise to force green.`,
			);
		}
	}
	for (const warning of report.warnings ?? []) {
		for (const blocked of warning.blocked_by ?? []) {
			const subject = atomSubject(blocked);
			const requirement = specSubjectToRequirementId(subject);
			if (blocked.endsWith(" addressed") && requirement.startsWith("REQ-")) {
				gaps.push(
					`${requirement} is not addressed — formalize it (acceptanceAtom) or defer it with deferral.rationale via planner_spec_submit.`,
				);
			} else if (blocked.endsWith(" holds")) {
				gaps.push(
					`Constraint "${warning.premise ?? "?"}" needs \`${subject}\`, but nothing establishes it. Add an evidence-backed assumption for it, or ask the user (draft question: "Should \`${subject}\` hold in this plan? What establishes it?").`,
				);
			} else {
				gaps.push(
					`"${warning.premise ?? "?"}" is blocked by \`${blocked}\`${warning.hint ? ` — ${warning.hint}` : ""}.`,
				);
			}
		}
	}
	if (report.underdetermined) {
		gaps.push(
			`Underdetermined on \`${report.underdetermined}\`: more than one model fits the spec. Assert the atom (assumption or constraint) or remove the ambiguity — do not leave it to interpretation.`,
		);
	}
	return gaps;
}

function atomSubject(atom: string): string {
	const unqualified = atom.replace(/^[a-z0-9_]+\./, "");
	return unqualified.split(" ")[0] ?? unqualified;
}

function sha256(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

/** Rewrite one `## …` section of coverage.md, preserving the others. */
export async function writeCoverageSection(
	fs: PlannerFs,
	planPaths: PlanStoragePaths,
	section: { heading: string; lines: string[] },
): Promise<void> {
	const existing = (await fs.exists(planPaths.coverageMd))
		? await fs.readText(planPaths.coverageMd)
		: "# Coverage\n";
	const block = [section.heading, "", ...section.lines, ""].join("\n");
	const pattern = new RegExp(
		`${escapeRegExp(section.heading)}\\n[\\s\\S]*?(?=\\n## |$)`,
		"u",
	);
	const next = pattern.test(existing)
		? existing.replace(pattern, `${block}`)
		: `${existing.trimEnd()}\n\n${block}`;
	await fs.writeTextAtomic(planPaths.coverageMd, `${next.trimEnd()}\n`);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseGateName(params: unknown): PlannerGateName {
	if (!params || typeof params !== "object" || Array.isArray(params)) {
		throw new TypeError("planner_gate_check parameters must be an object.");
	}
	const gate = (params as Record<string, unknown>).gate;
	if (
		typeof gate !== "string" ||
		!(PLANNER_GATE_NAMES as readonly string[]).includes(gate)
	) {
		throw new TypeError(
			`planner_gate_check.gate must be one of: ${PLANNER_GATE_NAMES.join(", ")}.`,
		);
	}
	return gate as PlannerGateName;
}

function blocked(text: string): PlannerGateToolResult {
	return {
		status: "blocked",
		toolName: PLANNER_GATE_TOOL_NAME,
		text,
		details: null,
	};
}
