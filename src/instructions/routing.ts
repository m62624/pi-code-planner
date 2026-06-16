import type { PlannerStage, PlannerStep } from "../storage/schema";
import { instructionFilePath } from "./paths";
import type { InstructionKey, InstructionPaths } from "./schema";

export interface InstructionRouteEntry {
	key: InstructionKey;
	defaultPath: string;
	globalAppendPath: string;
	projectAppendPath: string;
}

export interface InstructionRouting {
	keys: readonly InstructionKey[];
	entries: readonly InstructionRouteEntry[];
}

export function getInstructionRoutingForState(input: {
	state: {
		stage: PlannerStage;
		step: PlannerStep;
	};
	paths: InstructionPaths;
}): InstructionRouting {
	const keys = getInstructionKeysForPlannerStep(input.state);
	return {
		keys,
		entries: keys.map((key) => ({
			key,
			defaultPath: instructionFilePath(input.paths.defaultsDir, key),
			globalAppendPath: instructionFilePath(input.paths.globalAppendDir, key),
			projectAppendPath: instructionFilePath(input.paths.projectAppendDir, key),
		})),
	};
}

// Every branch here must only reference keys from INSTRUCTION_KEYS
// (schema.ts) that also have default content in defaults.ts — there is no
// runtime check tying the three files together.
export function getInstructionKeysForPlannerStep(input: {
	stage: PlannerStage;
	step: PlannerStep;
}): InstructionKey[] {
	const keys: InstructionKey[] = [stageInstructionKey(input.stage)];

	switch (input.stage) {
		case "init":
			if (isGitStep(input.step)) {
				keys.push("git");
			}
			break;
		case "intake":
			break;
		case "discovery":
			break;
		case "planning":
			break;
		case "execution":
			keys.push(...executionInstructionKeys(input.step));
			break;
		case "finalize":
			if (isGitStep(input.step)) {
				keys.push("git");
			}
			break;
		case "done":
			if (isGitStep(input.step)) {
				keys.push("git", "git-commit");
			}
			break;
		case "recovery":
			keys.push("git");
			break;
	}

	return unique(keys);
}

function stageInstructionKey(stage: PlannerStage): InstructionKey {
	return stage;
}

function executionInstructionKeys(step: PlannerStep): InstructionKey[] {
	if (
		step === "write_tdd_plan" ||
		step === "write_tests" ||
		step === "run_failing_tests"
	) {
		const keys: InstructionKey[] = ["tdd"];
		if (step === "write_tests") keys.push("git-commit");
		return keys;
	}

	if (step === "implement_task") {
		return ["tdd", "git-commit"];
	}

	if (step === "contract_check") {
		return ["tdd", "git-commit"];
	}

	if (step === "refactor_task") {
		return ["refactor", "git-commit"];
	}

	if (step === "run_final_tests") {
		return ["tdd", "refactor", "git-commit"];
	}

	if (
		step === "prepare_task" ||
		step === "merge_task_to_plan" ||
		step === "select_next_task"
	) {
		const keys: InstructionKey[] = ["git"];
		if (step === "merge_task_to_plan") {
			keys.splice(1, 0, "git-commit");
		}
		return keys;
	}

	return [];
}

function isGitStep(step: PlannerStep): boolean {
	return (
		step.includes("git") ||
		step.includes("branch") ||
		step.includes("merge") ||
		step.includes("worktree")
	);
}

function unique(keys: readonly InstructionKey[]): InstructionKey[] {
	return [...new Set(keys)];
}
