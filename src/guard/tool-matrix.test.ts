import { describe, expect, it } from "vitest";
import { PLANNER_STAGE_STEPS } from "../storage/schema";
import {
	ALL_PLANNER_TOOL_NAMES,
	getAllowedPlannerWrapperTools,
	PLANNER_LIFECYCLE_TRANSITION_TOOLS,
	PLANNER_WRAPPER_TOOLS,
	type PlannerWrapperTool,
} from "./tool-policy";

/**
 * The tool matrix, pinned.
 *
 * `getAllowedPlannerWrapperTools` is the call-time gate: it decides which
 * semantic wrapper tools the model may use at a given planner position. Two
 * separate things depend on it being exactly right, and both fail quietly:
 *
 *  - **Reachability.** A tool dropped from a step's list is not an error the
 *    model can report — it just gets refused and has no way forward. The step
 *    deadlocks and the only symptom is a stuck run.
 *  - **Prompt shape.** If the active tool list is ever narrowed to this set (so
 *    the schemas leave the request), then this matrix *is* the head of the
 *    prompt, and a change here re-reads the whole prefix on every backend that
 *    caches one. Order is part of the bytes, so the expectations below pin the
 *    order too, not just the membership.
 *
 * So the matrix is written out in full rather than recomputed: a test that
 * derives the answer from the same table it checks proves nothing. Regenerate
 * by hand when a step's tools genuinely change, and read the diff — every line
 * that moves is a tool the model gains or loses.
 *
 * The *visibility* layer (plan active, contract gate, recovery-report unlock)
 * is a different mechanism and is covered in `index.tool-visibility.test.ts`.
 */

const STAGE_STEP_MATRIX: Record<
	string,
	Record<string, readonly PlannerWrapperTool[]>
> = {
	init: {
		check_project: [
			"planner_status",
			"planner_artifact_read",
			"planner_git_inspect",
		],
		check_git: [
			"planner_status",
			"planner_artifact_read",
			"planner_git_inspect",
			"planner_git_init",
		],
		prepare_storage: ["planner_status", "planner_artifact_read"],
		choose_worktree_location: ["planner_status", "planner_artifact_read"],
		create_plan_record: ["planner_status", "planner_artifact_read"],
		create_plan_worktree: [
			"planner_status",
			"planner_artifact_read",
			"planner_git_inspect",
		],
		enter_intake: [
			"planner_status",
			"planner_artifact_read",
			"planner_git_inspect",
		],
	},
	intake: {
		draft_goal: [
			"planner_status",
			"planner_artifact_read",
			"planner_goal_submit",
		],
		await_goal_approval: [
			"planner_status",
			"planner_artifact_read",
			"planner_goal_decide",
		],
	},
	discovery: {
		scan_project_structure: [
			"planner_status",
			"planner_artifact_read",
			"planner_git_inspect",
			"planner_discovery_submit",
			"planner_contract_scan",
			"planner_contract_route",
			"planner_contract_read",
			"planner_contract_upsert",
			"planner_elenchus_check",
			"planner_reason",
			"planner_git_commit",
			"planner_exec",
		],
		write_questions: [
			"planner_status",
			"planner_artifact_read",
			"planner_questions_submit",
			"planner_questions_resolve",
			"planner_contract_scan",
			"planner_contract_route",
			"planner_contract_read",
			"planner_exec",
		],
		enter_planning: ["planner_status", "planner_artifact_read"],
	},
	spec: {
		draft_requirements: [
			"planner_status",
			"planner_artifact_read",
			"planner_spec_submit",
			"planner_contract_route",
			"planner_contract_read",
		],
		elicit_gaps: [
			"planner_status",
			"planner_artifact_read",
			"planner_questions_submit",
			"planner_questions_resolve",
			"planner_spec_submit",
		],
		verify_spec: [
			"planner_status",
			"planner_artifact_read",
			"planner_gate_check",
			"planner_spec_submit",
		],
		finish_spec: ["planner_status", "planner_artifact_read"],
	},
	planning: {
		read_context: [
			"planner_status",
			"planner_artifact_read",
			"planner_contract_route",
			"planner_contract_read",
		],
		draft_plan: [
			"planner_status",
			"planner_artifact_read",
			"planner_plan_submit",
			"planner_contract_route",
			"planner_contract_read",
		],
		split_tasks: [
			"planner_status",
			"planner_artifact_read",
			"planner_contract_route",
			"planner_contract_read",
		],
		write_task_files: [
			"planner_status",
			"planner_artifact_read",
			"planner_task_upsert",
			"planner_contract_route",
			"planner_contract_read",
		],
		verify_plan: ["planner_status", "planner_artifact_read"],
		consistency_check: [
			"planner_status",
			"planner_artifact_read",
			"planner_gate_check",
			"planner_elenchus_check",
			"planner_reason",
			"planner_task_upsert",
			"planner_contract_route",
			"planner_contract_read",
		],
		enter_execution: ["planner_status", "planner_artifact_read"],
	},
	execution: {
		prepare_task: [
			"planner_status",
			"planner_artifact_read",
			"planner_git_inspect",
			"planner_git_create_task_branch",
		],
		write_tdd_plan: [
			"planner_status",
			"planner_artifact_read",
			"planner_git_inspect",
			"planner_tdd_submit",
			"planner_behavior_upsert",
			"planner_gate_check",
			"planner_report_stuck",
			"planner_skill_create",
			"planner_skill_update",
			"planner_elenchus_check",
			"planner_reason",
			"planner_exec",
		],
		write_tests: [
			"planner_status",
			"planner_artifact_read",
			"planner_git_inspect",
			"planner_tdd_submit",
			"planner_behavior_upsert",
			"planner_gate_check",
			"planner_git_commit",
			"planner_report_stuck",
			"planner_skill_create",
			"planner_skill_update",
			"planner_exec",
		],
		run_failing_tests: [
			"planner_status",
			"planner_artifact_read",
			"planner_git_inspect",
			"planner_tdd_submit",
			"planner_behavior_upsert",
			"planner_gate_check",
			"planner_report_stuck",
			"planner_skill_create",
			"planner_skill_update",
			"planner_exec",
		],
		implement_task: [
			"planner_status",
			"planner_artifact_read",
			"planner_git_inspect",
			"planner_tdd_submit",
			"planner_git_commit",
			"planner_contract_route",
			"planner_contract_read",
			"planner_report_stuck",
			"planner_skill_create",
			"planner_skill_update",
			"planner_exec",
		],
		contract_check: [
			"planner_status",
			"planner_artifact_read",
			"planner_git_inspect",
			"planner_tdd_submit",
			"planner_git_commit",
			"planner_contract_route",
			"planner_contract_read",
			"planner_contract_check",
			"planner_contract_upsert",
			"planner_elenchus_check",
			"planner_reason",
			"planner_report_stuck",
			"planner_skill_create",
			"planner_skill_update",
			"planner_exec",
		],
		refactor_task: [
			"planner_status",
			"planner_artifact_read",
			"planner_git_inspect",
			"planner_tdd_submit",
			"planner_refactor_review",
			"planner_git_commit",
			"planner_contract_route",
			"planner_contract_read",
			"planner_contract_check",
			"planner_contract_upsert",
			"planner_git_create_refactor_branch",
			"planner_git_merge_refactor_to_task",
			"planner_report_stuck",
			"planner_skill_create",
			"planner_skill_update",
			"planner_exec",
		],
		run_final_tests: [
			"planner_status",
			"planner_artifact_read",
			"planner_git_inspect",
			"planner_tdd_submit",
			"planner_behavior_upsert",
			"planner_gate_check",
			"planner_git_commit",
			"planner_report_stuck",
			"planner_skill_create",
			"planner_skill_update",
			"planner_exec",
		],
		capture_skill: [
			"planner_status",
			"planner_artifact_read",
			"planner_git_inspect",
			"planner_skill_create",
			"planner_skill_update",
			"planner_git_discard_changes",
		],
		merge_task_to_plan: [
			"planner_status",
			"planner_artifact_read",
			"planner_git_inspect",
			"planner_tdd_submit",
			"planner_git_merge_task_to_plan",
		],
		select_next_task: [
			"planner_status",
			"planner_artifact_read",
			"planner_git_inspect",
		],
	},
	finalize: {
		verify_plan_branch: [
			"planner_status",
			"planner_artifact_read",
			"planner_git_inspect",
			"planner_contract_route",
			"planner_contract_read",
			"planner_git_discard_changes",
		],
		compact_before_doubt: ["planner_status", "planner_artifact_read"],
		doubt_review: [
			"planner_status",
			"planner_artifact_read",
			"planner_git_inspect",
			"planner_doubt_review",
			"planner_elenchus_check",
			"planner_reason",
			"planner_skill_create",
			"planner_skill_update",
			"planner_contract_route",
			"planner_contract_read",
			"planner_contract_check",
			"planner_contract_upsert",
			"planner_git_discard_changes",
		],
		write_final_summary: [
			"planner_status",
			"planner_artifact_read",
			"planner_summary_submit",
			"planner_skill_create",
			"planner_skill_update",
			"planner_contract_route",
			"planner_contract_read",
			"planner_contract_check",
			"planner_contract_upsert",
			"planner_git_discard_changes",
		],
		enter_done: ["planner_status", "planner_artifact_read"],
	},
	done: {
		present_result: [
			"planner_status",
			"planner_artifact_read",
			"planner_skill_create",
			"planner_skill_update",
			"planner_contract_decide",
			"planner_git_discard_changes",
		],
		await_user_acceptance: [
			"planner_status",
			"planner_artifact_read",
			"planner_contract_decide",
			"planner_git_discard_changes",
		],
		handle_change_request: [
			"planner_status",
			"planner_artifact_read",
			"planner_plan_submit",
			"planner_discovery_submit",
		],
		prepare_output_branch: ["planner_status", "planner_artifact_read"],
		merge_or_export_result: ["planner_status", "planner_artifact_read"],
		cleanup_worktree: ["planner_status", "planner_artifact_read"],
		mark_done: ["planner_status", "planner_artifact_read"],
		cleanup_plan_files: ["planner_status", "planner_artifact_read"],
	},
	recovery: {
		read_state: [
			"planner_status",
			"planner_artifact_read",
			"planner_recovery_inspect",
		],
		inspect_git: [
			"planner_status",
			"planner_artifact_read",
			"planner_git_inspect",
			"planner_recovery_inspect",
		],
		compare_expected_actual: [
			"planner_status",
			"planner_artifact_read",
			"planner_recovery_inspect",
		],
		classify_recovery: [
			"planner_status",
			"planner_artifact_read",
			"planner_recovery_inspect",
		],
		ask_user_if_destructive: [
			"planner_status",
			"planner_artifact_read",
			"planner_recovery_inspect",
		],
		repair_or_resume: [
			"planner_status",
			"planner_artifact_read",
			"planner_recovery_inspect",
			"planner_recovery_resume",
			"planner_git_inspect",
			"planner_elenchus_check",
			"planner_reason",
		],
	},
};

/** A running, healthy state at the given position — the matrix baseline. */
function runningAt(stage: string, step: string) {
	return {
		stage,
		step,
		broken: false,
		requiresUserDecision: false,
		requiresCompact: false,
		debugArtifactsDir: null,
	} as never;
}

const DEBUG_TOOLS = [
	"planner_debug_strategy",
	"planner_debug_probe",
	"planner_debug_result",
	"planner_debug_cleanup",
] as const;

// Read-only and cross-stage: refusing these can never protect the state machine,
// and losing them blinds the model everywhere, including in recovery.
const ALWAYS = ["planner_status", "planner_artifact_read"] as const;

describe("stage/step tool matrix", () => {
	it("covers every stage and step the state machine can be in", () => {
		expect(Object.keys(STAGE_STEP_MATRIX).sort()).toEqual(
			Object.keys(PLANNER_STAGE_STEPS).sort(),
		);
		for (const [stage, steps] of Object.entries(PLANNER_STAGE_STEPS)) {
			expect(Object.keys(STAGE_STEP_MATRIX[stage])).toEqual([...steps]);
		}
	});

	for (const [stage, steps] of Object.entries(STAGE_STEP_MATRIX)) {
		for (const [step, expected] of Object.entries(steps)) {
			it(`${stage}/${step} offers exactly ${expected.length} tools, in order`, () => {
				expect(getAllowedPlannerWrapperTools(runningAt(stage, step))).toEqual(
					expected,
				);
			});
		}
	}

	it("offers the read-only pair at every single position", () => {
		for (const [stage, steps] of Object.entries(STAGE_STEP_MATRIX)) {
			for (const step of Object.keys(steps)) {
				const tools = getAllowedPlannerWrapperTools(runningAt(stage, step));
				expect(tools.slice(0, ALWAYS.length)).toEqual([...ALWAYS]);
			}
		}
	});
});

describe("tool reachability", () => {
	it("leaves no wrapper tool unreachable from a normal run", () => {
		const reachable = new Set<string>();
		for (const [stage, steps] of Object.entries(STAGE_STEP_MATRIX)) {
			for (const step of Object.keys(steps)) {
				for (const tool of getAllowedPlannerWrapperTools(
					runningAt(stage, step),
				)) {
					reachable.add(tool);
				}
			}
		}
		// Opened only by planner_report_stuck, so they are absent from the baseline.
		for (const tool of DEBUG_TOOLS) reachable.add(tool);
		// Reached through the preflight decision before a plan exists
		// (STATUS_ONLY_TOOLS in runtime/planner-runtime.ts), never through a step.
		reachable.add("planner_create_plan");
		// Offered only while the run is broken / awaiting a user decision.
		reachable.add("planner_recovery_inspect");
		reachable.add("planner_recovery_resume");

		expect(PLANNER_WRAPPER_TOOLS.filter((t) => !reachable.has(t))).toEqual([]);
	});

	it("keeps lifecycle transitions out of the wrapper gate entirely", () => {
		// They are gated by their own exit conditions, not by this allowlist; if one
		// ever appeared here it could be refused and the machine could not advance.
		for (const tool of PLANNER_LIFECYCLE_TRANSITION_TOOLS) {
			expect(PLANNER_WRAPPER_TOOLS as readonly string[]).not.toContain(tool);
			expect(ALL_PLANNER_TOOL_NAMES as readonly string[]).toContain(tool);
		}
	});
});

describe("tools that appear and disappear with run state", () => {
	// planner_report_stuck opens a debug session (sets debugArtifactsDir); the four
	// debug wrappers appear then, and planner_debug_cleanup closes it again. This is
	// the one place where the offered set changes without the step changing.
	it("adds the debug wrappers when a stuck debug session is open", () => {
		const closed = getAllowedPlannerWrapperTools(
			runningAt("execution", "implement_task"),
		);
		const open = getAllowedPlannerWrapperTools({
			...runningAt("execution", "implement_task"),
			debugArtifactsDir: "/w/.pi/pi-code-planner/debug/task/sess",
		} as never);

		expect(closed).not.toContain("planner_debug_probe");
		expect(
			open.filter((t) => (DEBUG_TOOLS as readonly string[]).includes(t)),
		).toEqual([...DEBUG_TOOLS]);
		// Opening a debug session only adds; nothing the model had is taken away.
		expect(
			open.filter((t) => !(DEBUG_TOOLS as readonly string[]).includes(t)),
		).toEqual([...closed]);
	});

	it("removes them again once the debug session is cleaned up", () => {
		const after = getAllowedPlannerWrapperTools(
			runningAt("execution", "implement_task"),
		);
		for (const tool of DEBUG_TOOLS) expect(after).not.toContain(tool);
	});

	// The debug wrappers are derived, not listed per step: they are offered exactly
	// when a session is open AND the step could have opened one (it allows
	// planner_report_stuck). Pinned as an equality over the whole stage so the two
	// halves of the stuck flow cannot drift apart again — they did once, and
	// contract_check ended up able to open a session it could not close.
	const STUCK_STEPS = [
		"write_tdd_plan",
		"write_tests",
		"run_failing_tests",
		"implement_task",
		"contract_check",
		"refactor_task",
		"run_final_tests",
	] as const;

	it("allows planner_report_stuck on exactly these execution steps", () => {
		const actual = Object.entries(STAGE_STEP_MATRIX.execution)
			.filter(([, tools]) => tools.includes("planner_report_stuck"))
			.map(([step]) => step);
		expect(actual).toEqual([...STUCK_STEPS]);
	});

	it("drives the debug loop on exactly the steps that can report stuck", () => {
		const withDebug = (step: string) =>
			getAllowedPlannerWrapperTools({
				...runningAt("execution", step),
				debugArtifactsDir: "/w/dbg",
			} as never);
		const actual = Object.keys(STAGE_STEP_MATRIX.execution).filter((step) =>
			withDebug(step).includes("planner_debug_probe"),
		);
		expect(actual).toEqual([...STUCK_STEPS]);
	});

	it("can always close a session it was able to open", () => {
		// The failure this replaces: report stuck at contract_check, then find
		// planner_git_commit blocked by the leftover artifacts and planner_debug_cleanup
		// refused by the step.
		for (const step of STUCK_STEPS) {
			const open = getAllowedPlannerWrapperTools({
				...runningAt("execution", step),
				debugArtifactsDir: "/w/dbg",
			} as never);
			expect(open).toContain("planner_debug_cleanup");
		}
	});

	it("offers no debug wrapper on a step that cannot report stuck", () => {
		const open = getAllowedPlannerWrapperTools({
			...runningAt("execution", "prepare_task"),
			debugArtifactsDir: "/w/dbg",
		} as never);
		for (const tool of DEBUG_TOOLS) expect(open).not.toContain(tool);
	});

	it("collapses to recovery tools while broken", () => {
		expect(
			getAllowedPlannerWrapperTools({
				...runningAt("execution", "implement_task"),
				broken: true,
			} as never),
		).toEqual([
			"planner_status",
			"planner_artifact_read",
			"planner_git_inspect",
			"planner_recovery_inspect",
			"planner_recovery_resume",
		]);
	});

	it("collapses to the same set while awaiting a user decision", () => {
		expect(
			getAllowedPlannerWrapperTools({
				...runningAt("done", "await_user_acceptance"),
				requiresUserDecision: true,
			} as never),
		).toEqual([
			"planner_status",
			"planner_artifact_read",
			"planner_git_inspect",
			"planner_recovery_inspect",
			"planner_recovery_resume",
		]);
	});

	it("adds the consistency checker at the repair decision, and only there", () => {
		const repair = getAllowedPlannerWrapperTools({
			...runningAt("recovery", "repair_or_resume"),
			broken: true,
		} as never);
		expect(repair).toEqual([
			"planner_status",
			"planner_artifact_read",
			"planner_git_inspect",
			"planner_recovery_inspect",
			"planner_recovery_resume",
			"planner_elenchus_check",
			"planner_reason",
		]);
		const otherRecoveryStep = getAllowedPlannerWrapperTools({
			...runningAt("recovery", "classify_recovery"),
			broken: true,
		} as never);
		expect(otherRecoveryStep).not.toContain("planner_elenchus_check");
	});

	it("collapses to the read-only pair while a compact boundary is pending", () => {
		expect(
			getAllowedPlannerWrapperTools({
				...runningAt("finalize", "compact_before_doubt"),
				requiresCompact: true,
			} as never),
		).toEqual([...ALWAYS]);
	});
});
