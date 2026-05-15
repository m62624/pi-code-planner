import type { PlannerFs } from "../settings/fs";
import type { SettingsPaths } from "../settings/paths";
import type { PlannerRuntimeState } from "./schema";
import {
	initializePlannerRuntimeState,
	loadPlannerRuntimeState,
	savePlannerRuntimeState,
} from "./store";

export interface RuntimeStateManagerOptions {
	paths: Pick<SettingsPaths, "globalDir" | "globalState">;
	fs: PlannerFs;
}

export interface RuntimeStateInitResult {
	created: boolean;
	path: string;
	state: PlannerRuntimeState;
}

export class RuntimeStateManager {
	private cachedState: PlannerRuntimeState | null = null;

	constructor(private options: RuntimeStateManagerOptions) {}

	initialize(): RuntimeStateInitResult {
		const result = initializePlannerRuntimeState(
			this.options.paths,
			this.options.fs,
		);
		this.cachedState = result.state;
		return result;
	}

	load(): PlannerRuntimeState {
		const state = loadPlannerRuntimeState(this.options.paths, this.options.fs);
		this.cachedState = state;
		return state;
	}

	get(): PlannerRuntimeState {
		if (!this.cachedState) {
			return this.load();
		}
		return this.cachedState;
	}

	refresh(): PlannerRuntimeState {
		return this.load();
	}

	replace(state: PlannerRuntimeState): PlannerRuntimeState {
		savePlannerRuntimeState(this.options.paths, this.options.fs, state);
		this.cachedState = state;
		return state;
	}

	update(
		mutator: (state: PlannerRuntimeState) => PlannerRuntimeState,
	): PlannerRuntimeState {
		const current = this.get();
		const next = mutator(current);
		return this.replace(next);
	}

	isActive(): boolean {
		const state = this.get();
		return (
			state.activePlanId !== null ||
			state.mode === "operation_in_progress" ||
			state.mode === "recovery_required"
		);
	}

	sleep(): PlannerRuntimeState {
		return this.update((state) => ({
			...state,
			mode: "idle",
			activePlanId: null,
			activeWorkItemId: null,
			pendingOperation: null,
			pendingCompact: null,
		}));
	}
}
