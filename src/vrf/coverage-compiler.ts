import type { TaskRecord } from "../storage/schema";
import type { SpecRecord } from "../storage/spec-store";
import { specRequirementSubject } from "./spec-compiler";

/**
 * Deterministic plan-coverage compiler (SPEC.md REQ-4b/4c): from `spec.json`
 * plus each task's traceability it emits the Skolem witness tables + logic web
 * the coverage gate runs. Two totalities are always present:
 *
 * - `TOTAL covered_by ON requirements` — every in-scope, non-deferred
 *   requirement must be the subject of at least one `covered_by` pair; the
 *   engine NAMES each dropped requirement.
 *
 * The orphan dimension has two modes, chosen by the plan itself:
 *
 * - **dependency mode** (some task declares `dependsOn`): a task is not orphan
 *   if it DISCHARGES a requirement OR a discharging task (transitively) depends
 *   on it. Emitted as `depends_on` facts + `CLOSE depends_on TRANSITIVE` (which
 *   also rejects a dependency cycle — a DAG check the old model lacked) + two
 *   `RULE`s that derive `is_justified`, gated by `PREMISE every_task_justified`.
 *   This is what lets a `cargo init` task own zero requirements yet not be
 *   orphan work: the task that discharges REQ-1 depends on it.
 * - **legacy mode** (no task declares `dependsOn` — every pre-dependsOn plan):
 *   the old `TOTAL traces ON tasks`, where every task must itself cite a
 *   requirement. Grandfathered so resuming an existing plan never breaks; a
 *   plan opts into dependency mode the moment any task declares `dependsOn`.
 *
 * Requirements discharged through the freedom valve (deferral) and non-goals
 * never enter the requirement set (REQ-3, §2.2): a deferral IS the discharge.
 *
 * The program is fully self-contained (no template import): elenchus SETs are
 * data and do not cross files, so the sets, the witness pairs, and the TOTAL
 * lines must live in one generated file. That is fine — this program is
 * compiler-authored end to end (REQ-12), there is nothing for a model to get
 * wrong.
 */

export interface CompiledPlanCoverage {
	program: string;
	/** Maps a VRF task subject back to the real taskId, for gap reporting. */
	taskSubjects: Record<string, string>;
	requirementCount: number;
	taskCount: number;
	/** Requirements a task cites that the spec does not know (hard error upstream). */
	unknownRequirementRefs: Array<{ taskId: string; requirement: string }>;
	/** dependsOn ids that name no task in the plan (hard error upstream). */
	unknownDependencyRefs: Array<{ taskId: string; dependsOn: string }>;
	/** A dependency cycle among tasks, as an ordered taskId path, or null. */
	dependencyCycle: string[] | null;
	mode: "legacy" | "dependency";
}

/** `fix-storage-root` → `task_fix_storage_root` (collision-checked). */
function taskSubjectFor(taskId: string, used: Set<string>): string {
	const base = `task_${taskId.toLowerCase().replace(/[^a-z0-9_]+/g, "_")}`;
	let candidate = base;
	let suffix = 2;
	while (used.has(candidate)) {
		candidate = `${base}_${suffix}`;
		suffix += 1;
	}
	used.add(candidate);
	return candidate;
}

/**
 * First dependency cycle among the tasks (over declared, in-plan edges), as an
 * ordered taskId path `a → b → … → a`, or null for a DAG. Detected in TS so the
 * gate reports a clean message instead of relying on the engine's CLOSE crash.
 */
function findDependencyCycle(
	adjacency: Map<string, string[]>,
): string[] | null {
	const WHITE = 0;
	const GREY = 1;
	const BLACK = 2;
	const color = new Map<string, number>();
	const stack: string[] = [];
	let cycle: string[] | null = null;

	function visit(node: string): boolean {
		color.set(node, GREY);
		stack.push(node);
		for (const next of adjacency.get(node) ?? []) {
			const c = color.get(next) ?? WHITE;
			if (c === GREY) {
				const from = stack.indexOf(next);
				cycle = [...stack.slice(from), next];
				return true;
			}
			if (c === WHITE && visit(next)) return true;
		}
		stack.pop();
		color.set(node, BLACK);
		return false;
	}

	for (const node of adjacency.keys()) {
		if ((color.get(node) ?? WHITE) === WHITE && visit(node)) break;
	}
	return cycle;
}

export function compilePlanCoverage(
	spec: SpecRecord,
	tasks: readonly TaskRecord[],
): CompiledPlanCoverage {
	const coverable = [...spec.requirements]
		.filter((req) => req.inScope && req.deferral === undefined)
		.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
	const orderedTasks = [...tasks].sort((a, b) =>
		a.taskId.localeCompare(b.taskId, "en", { numeric: true }),
	);

	const knownRequirementIds = new Set(spec.requirements.map((req) => req.id));
	const coverableIds = new Set(coverable.map((req) => req.id));
	const taskIds = new Set(orderedTasks.map((task) => task.taskId));

	const usedSubjects = new Set<string>();
	const taskSubjects: Record<string, string> = {};
	const subjectByTaskId = new Map<string, string>();
	for (const task of orderedTasks) {
		const subject = taskSubjectFor(task.taskId, usedSubjects);
		taskSubjects[subject] = task.taskId;
		subjectByTaskId.set(task.taskId, subject);
	}

	const unknownRequirementRefs: CompiledPlanCoverage["unknownRequirementRefs"] =
		[];
	const unknownDependencyRefs: CompiledPlanCoverage["unknownDependencyRefs"] =
		[];

	const usesDeps = orderedTasks.some(
		(task) => (task.dependsOn ?? []).length > 0,
	);
	const mode: CompiledPlanCoverage["mode"] = usesDeps ? "dependency" : "legacy";

	const lines: string[] = [
		"// Generated by pi-code-planner's deterministic coverage compiler from",
		"// spec.json + the tasks' traceability. Do not edit by hand.",
		"DOMAIN plan_coverage",
		"",
	];

	if (coverable.length > 0) {
		lines.push("SET requirements");
		for (const req of coverable) {
			lines.push(`    ${specRequirementSubject(req.id)}`);
		}
		lines.push("");
	}
	if (orderedTasks.length > 0) {
		lines.push("SET tasks");
		for (const task of orderedTasks) {
			lines.push(`    ${subjectByTaskId.get(task.taskId) as string}`);
		}
		lines.push("");
	}

	// covered_by witnesses (both modes): a task's cited requirement covers it.
	for (const task of orderedTasks) {
		const subject = subjectByTaskId.get(task.taskId) as string;
		for (const requirement of [...(task.requirements ?? [])].sort()) {
			if (!knownRequirementIds.has(requirement)) {
				unknownRequirementRefs.push({ taskId: task.taskId, requirement });
				continue;
			}
			if (coverableIds.has(requirement)) {
				lines.push(
					`FACT ${specRequirementSubject(requirement)} covered_by ${subject}`,
				);
			}
		}
	}

	let dependencyCycle: string[] | null = null;

	if (mode === "legacy") {
		// Every task must itself cite a coverable-or-deferred requirement.
		for (const task of orderedTasks) {
			const subject = subjectByTaskId.get(task.taskId) as string;
			for (const requirement of [...(task.requirements ?? [])].sort()) {
				if (!knownRequirementIds.has(requirement)) continue; // already flagged
				lines.push(
					`FACT ${subject} traces ${specRequirementSubject(requirement)}`,
				);
			}
		}
		lines.push("");
		if (coverable.length > 0) lines.push("TOTAL covered_by ON requirements");
		if (orderedTasks.length > 0) lines.push("TOTAL traces ON tasks");
	} else {
		// Dependency mode: justify each task structurally.
		const adjacency = new Map<string, string[]>();
		for (const task of orderedTasks) adjacency.set(task.taskId, []);
		for (const task of orderedTasks) {
			for (const dep of [...new Set(task.dependsOn ?? [])].sort()) {
				if (!taskIds.has(dep)) {
					unknownDependencyRefs.push({ taskId: task.taskId, dependsOn: dep });
					continue;
				}
				adjacency.get(task.taskId)?.push(dep);
			}
		}
		dependencyCycle = findDependencyCycle(adjacency);

		for (const task of orderedTasks) {
			const subject = subjectByTaskId.get(task.taskId) as string;
			lines.push(`FACT ${subject} in_plan`);
		}
		for (const task of orderedTasks) {
			const subject = subjectByTaskId.get(task.taskId) as string;
			const discharges = [...(task.requirements ?? [])].some((req) =>
				coverableIds.has(req),
			);
			if (discharges) lines.push(`FACT ${subject} discharges_req`);
		}
		let edgeCount = 0;
		for (const task of orderedTasks) {
			const subject = subjectByTaskId.get(task.taskId) as string;
			for (const dep of adjacency.get(task.taskId) ?? []) {
				lines.push(
					`FACT ${subject} depends_on ${subjectByTaskId.get(dep) as string}`,
				);
				edgeCount += 1;
			}
		}
		// CLOSE rejects a cycle at compile time; skip it when TS already found one
		// so the gate can report a clean message instead of an engine crash.
		if (edgeCount > 0 && !dependencyCycle) {
			lines.push("CLOSE depends_on TRANSITIVE");
		}
		lines.push("");
		if (coverable.length > 0) lines.push("TOTAL covered_by ON requirements");
		lines.push(
			"RULE self_justified FOR EACH t IN tasks:",
			"    WHEN t discharges_req",
			"    THEN t is_justified",
			"RULE dep_justified FOR EACH d depends_on t:",
			"    WHEN d discharges_req",
			"    THEN t is_justified",
			"PREMISE every_task_justified FOR EACH t IN tasks:",
			"    WHEN t in_plan",
			"    THEN t is_justified",
		);
	}

	lines.push("", "CHECK");

	return {
		program: `${lines.join("\n").replace(/\n{3,}/g, "\n\n")}\n`,
		taskSubjects,
		requirementCount: coverable.length,
		taskCount: orderedTasks.length,
		unknownRequirementRefs,
		unknownDependencyRefs,
		dependencyCycle,
		mode,
	};
}
