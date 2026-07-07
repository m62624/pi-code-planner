import { SCHEMA_VERSION } from "../constants";
import type { PlannerFs } from "./fs";
import { readJson, readJsonIfExists, writeJson } from "./json";
import type { TaskStoragePaths } from "./paths";

/**
 * Per-task behavior registry (`tasks/<id>/behaviors.json`) — the "toggle
 * board" of the execution-phase test-coverage gate. Each observable behavior
 * of the task is one entry; as tests get written and pass, the model flips
 * its status through the mechanical ladder:
 *
 *   planned → red   (a named test exists and FAILS before the implementation)
 *   red     → green (the same test passes after the implementation)
 *
 * A `planned → green` jump is rejected at the store level — test-first is
 * enforced by data, not by prose. The tdd_coverage gate compiles this file
 * into `TOTAL … ON behaviors`, so the engine NAMES every behavior that still
 * lacks a red (write_tests) or green (run_final_tests) witness: the model
 * does not "believe" its coverage, it reads the machine's list of holes.
 */

export type TaskBehaviorKind = "happy" | "edge" | "error" | "concurrency";
export type TaskBehaviorStatus = "planned" | "red" | "green";

/**
 * One if/else/error branch of a behavior's invariant. `covered` flips true only
 * once a test drives that branch — the tdd_coverage gate compiles the branch
 * set into `TOTAL … ON branches` so every untested branch is NAMED, turning
 * "все if условия" into a machine-checked coverage ledger instead of prose.
 */
export interface TaskBehaviorBranch {
	/** Stable id, strictly `BR-<n>`, unique within its behavior. */
	id: string;
	/** The branch condition as a checkable phrase, e.g. "dep already exists → duplicate rejected". */
	condition: string;
	/** True once a test exercises this branch (only when the behavior is red/green). */
	covered: boolean;
}

export interface TaskBehavior {
	/** Stable id, strictly `BHV-<n>`, unique within the task. */
	id: string;
	/** The observable behavior, phrased as a checkable claim. */
	statement: string;
	kind: TaskBehaviorKind;
	/** Optional spec traceability: the REQ-n this behavior exercises. */
	requirement: string | null;
	/** The concrete test that witnesses the behavior; required once red. */
	test: { file: string; name: string } | null;
	/** The invariant's branches; empty for a behavior with no branching. */
	branches: TaskBehaviorBranch[];
	status: TaskBehaviorStatus;
}

export interface TaskBehaviorsRecord {
	schemaVersion: typeof SCHEMA_VERSION;
	taskId: string;
	behaviors: TaskBehavior[];
}

const BEHAVIOR_KINDS: readonly TaskBehaviorKind[] = [
	"happy",
	"edge",
	"error",
	"concurrency",
];
const BEHAVIOR_STATUSES: readonly TaskBehaviorStatus[] = [
	"planned",
	"red",
	"green",
];

const STATUS_RANK: Record<TaskBehaviorStatus, number> = {
	planned: 0,
	red: 1,
	green: 2,
};

export function validateTaskBehaviors(input: {
	taskId: string;
	behaviors: TaskBehavior[];
	/** The previously persisted record, for transition checking. */
	previous: TaskBehaviorsRecord | null;
}): TaskBehaviorsRecord {
	if (!Array.isArray(input.behaviors) || input.behaviors.length === 0) {
		throw new TypeError(
			"behaviors must be a non-empty array — enumerate every observable behavior of the task (happy path, edge, error, concurrency where applicable).",
		);
	}
	const seen = new Set<string>();
	const previousById = new Map(
		(input.previous?.behaviors ?? []).map((behavior) => [
			behavior.id,
			behavior,
		]),
	);
	const behaviors = input.behaviors.map((behavior, index) => {
		const where = `behaviors[${index}]`;
		const id = (behavior.id ?? "").trim();
		if (!/^BHV-\d+$/.test(id)) {
			throw new TypeError(`${where}.id must match BHV-<n> (got "${id}").`);
		}
		if (seen.has(id)) {
			throw new TypeError(`${where}.id "${id}" is declared more than once.`);
		}
		seen.add(id);
		const statement = (behavior.statement ?? "").trim();
		if (!statement) {
			throw new TypeError(`${where}.statement must be a non-empty string.`);
		}
		if (!BEHAVIOR_KINDS.includes(behavior.kind)) {
			throw new TypeError(
				`${where}.kind must be one of ${BEHAVIOR_KINDS.join(" | ")}.`,
			);
		}
		if (!BEHAVIOR_STATUSES.includes(behavior.status)) {
			throw new TypeError(
				`${where}.status must be one of ${BEHAVIOR_STATUSES.join(" | ")}.`,
			);
		}
		const previous = previousById.get(id);
		const from = previous?.status ?? "planned";
		// The toggle ladder: one forward step at a time; going back (a test
		// regressed, a plan changed) is always honest and allowed.
		if (STATUS_RANK[behavior.status] - STATUS_RANK[from] > 1) {
			throw new TypeError(
				`${where} (${id}): status cannot jump ${from} → ${behavior.status}. Test-first is mechanical: a behavior turns red (a named test exists and fails) before it can turn green.`,
			);
		}
		// Upsert is a merge, not a replace: a resubmit that omits an optional field
		// KEEPS the previously stored value, while an explicit value (including
		// `null` / `[]`) overwrites it. This lets the model flip a status without
		// re-typing the requirement, test, and branches every time — omitting them
		// used to silently wipe them (REQ-n → null, coverage → []).
		const test =
			"test" in behavior ? (behavior.test ?? null) : (previous?.test ?? null);
		if (behavior.status !== "planned") {
			const file = test?.file?.trim() ?? "";
			const name = test?.name?.trim() ?? "";
			if (!file || !name) {
				throw new TypeError(
					`${where} (${id}): a ${behavior.status} behavior must name its witnessing test ({ file, name }).`,
				);
			}
		}
		const requirement =
			"requirement" in behavior
				? behavior.requirement?.trim() || null
				: (previous?.requirement ?? null);
		if (requirement !== null && !/^REQ-\d+$/.test(requirement)) {
			throw new TypeError(
				`${where}.requirement must be a REQ-<n> id or null (got "${requirement}").`,
			);
		}
		const branches = normalizeBranches(
			"branches" in behavior ? behavior.branches : previous?.branches,
			behavior.status,
			where,
		);
		return {
			id,
			statement,
			kind: behavior.kind,
			requirement,
			test:
				behavior.status !== "planned" && test
					? { file: test.file.trim(), name: test.name.trim() }
					: test,
			branches,
			status: behavior.status,
		} satisfies TaskBehavior;
	});
	// Dropping a previously red/green behavior silently would un-count done
	// work; require the full list every time.
	for (const [id, previous] of previousById) {
		if (!seen.has(id) && previous.status !== "planned") {
			throw new TypeError(
				`Behavior ${id} (${previous.status}) is missing from the submitted list. Submit the FULL behavior list; remove a tested behavior only by first explaining it in the statement of a replacement.`,
			);
		}
	}
	return {
		schemaVersion: SCHEMA_VERSION,
		taskId: input.taskId,
		behaviors,
	};
}

function normalizeBranches(
	value: unknown,
	status: TaskBehaviorStatus,
	where: string,
): TaskBehaviorBranch[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) {
		throw new TypeError(`${where}.branches must be an array when present.`);
	}
	const seen = new Set<string>();
	return value.map((raw, index) => {
		const branch = (raw ?? {}) as Partial<TaskBehaviorBranch>;
		const id = (branch.id ?? "").trim();
		if (!/^BR-\d+$/.test(id)) {
			throw new TypeError(
				`${where}.branches[${index}].id must match BR-<n> (got "${id}").`,
			);
		}
		if (seen.has(id)) {
			throw new TypeError(
				`${where}.branches[${index}].id "${id}" is declared more than once.`,
			);
		}
		seen.add(id);
		const condition = (branch.condition ?? "").trim();
		if (!condition) {
			throw new TypeError(
				`${where}.branches[${index}].condition must be a non-empty string.`,
			);
		}
		const covered = branch.covered === true;
		// A branch is "covered" only when a test exercises it, so it cannot be
		// covered before the behavior itself has a failing test — test-first
		// enforced mechanically, same as the status ladder.
		if (covered && status === "planned") {
			throw new TypeError(
				`${where}.branches[${index}] (${id}): a branch cannot be covered while the behavior is still planned — write the test first.`,
			);
		}
		return { id, condition, covered } satisfies TaskBehaviorBranch;
	});
}

export async function writeTaskBehaviors(
	fs: PlannerFs,
	paths: TaskStoragePaths,
	record: TaskBehaviorsRecord,
): Promise<void> {
	await writeJson(fs, paths.behaviorsJson, record);
}

export async function readTaskBehaviors(
	fs: PlannerFs,
	paths: TaskStoragePaths,
): Promise<TaskBehaviorsRecord> {
	return await readJson<TaskBehaviorsRecord>(fs, paths.behaviorsJson);
}

/** Legacy tasks predate the behavior registry; absence is a supported state. */
export async function readTaskBehaviorsIfExists(
	fs: PlannerFs,
	paths: TaskStoragePaths,
): Promise<TaskBehaviorsRecord | null> {
	return await readJsonIfExists<TaskBehaviorsRecord>(fs, paths.behaviorsJson);
}
