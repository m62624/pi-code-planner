import type { DirtyMemoryState } from "./schema";

export type MemoryPolicyOperation =
	| "request_compact"
	| "finish_work_item"
	| "transition_from_signature_refresh";

export type MemoryPolicyDecision =
	| { kind: "allow"; operation: MemoryPolicyOperation; message: string }
	| {
			kind: "block";
			operation: MemoryPolicyOperation;
			message: string;
			dirtyFiles: string[];
	  };

export interface CheckMemoryPolicyInput {
	operation: MemoryPolicyOperation;
	dirty: DirtyMemoryState;
}

export function checkMemoryPolicy(
	input: CheckMemoryPolicyInput,
): MemoryPolicyDecision {
	const dirtyFiles = Object.keys(input.dirty.files).sort();
	if (dirtyFiles.length === 0) {
		return {
			kind: "allow",
			operation: input.operation,
			message: "Project memory is clean.",
		};
	}

	return {
		kind: "block",
		operation: input.operation,
		message: `Project memory has ${dirtyFiles.length} dirty file(s); run signature_refresh before ${input.operation}.`,
		dirtyFiles,
	};
}
