import {
	decidePlannerNextAction,
	type PlannerDecision,
} from "../decision/engine";
import type { GitRecoveryAnalysis } from "../git/recovery";
import { analyzeGitRecovery } from "../git/recovery";
import type { RepoState } from "../git/state";
import type { MemoryCore } from "../memory/core";
import { syncDirtyMemoryFromRepo } from "../memory/dirty-sync";
import type { DirtyMemoryState } from "../memory/schema";
import type { PlannerOrchestrator } from "../orchestrator/planner-orchestrator";
import type { RuntimeStateManager } from "../planner-state/runtime";
import type { PlannerRuntimeState } from "../planner-state/schema";
import type { AssemblePlannerPromptResult } from "../prompts/assembler";
import type { MemorySettings } from "../settings/schema";
import type { PlanRecord, WorkItemRecord } from "../storage/schema";

export type PlannerRuntimeStatus =
	| "idle"
	| "ready"
	| "compact_pending"
	| "compact_required"
	| "memory_refresh_required"
	| "recovery_required";

export interface PlannerRuntimeControllerCore {
	state: RuntimeStateManager;
	readRepoState(): Promise<RepoState>;
}

export interface PlannerRuntimeInspection {
	status: PlannerRuntimeStatus;
	message: string;
	state: PlannerRuntimeState;
	repo: RepoState;
	recovery: GitRecoveryAnalysis;
	memory: {
		dirty: DirtyMemoryState;
		hasDirtyFiles: boolean;
	};
	decision: PlannerDecision;
	plan: PlanRecord | null;
	workItem: WorkItemRecord | null;
	nextPrompt: AssemblePlannerPromptResult | null;
}

export class PlannerRuntimeController {
	constructor(
		private core: PlannerRuntimeControllerCore,
		private orchestrator: PlannerOrchestrator,
		private memory?: MemoryCore,
		private memorySettings?: MemorySettings,
	) {}

	async inspect(): Promise<PlannerRuntimeInspection> {
		const state = this.core.state.get();
		const repo = await this.core.readRepoState();
		const recovery = analyzeGitRecovery(state, repo);
		const memory = this.memorySnapshot(state, repo);
		const idleDecision = decidePlannerNextAction({
			state,
			repo,
			recovery,
			memory: memory.dirty,
		});

		if (idleDecision.status === "idle") {
			return this.result({
				status: "idle",
				message: idleDecision.message,
				state,
				repo,
				recovery,
				memory,
				decision: idleDecision,
			});
		}

		return this.activeResult(state, repo, recovery, memory);
	}

	private activeResult(
		state: PlannerRuntimeState,
		repo: RepoState,
		recovery: GitRecoveryAnalysis,
		memory: PlannerRuntimeInspection["memory"],
	): PlannerRuntimeInspection {
		if (!state.activePlanId) {
			const decision = decidePlannerNextAction({
				state,
				repo,
				recovery,
				memory: memory.dirty,
			});
			return this.result({
				status: "recovery_required",
				message: decision.message,
				state,
				repo,
				recovery,
				memory,
				decision,
			});
		}

		try {
			const plan = this.orchestrator.readPlan(state.activePlanId);
			const workItem = state.activeWorkItemId
				? this.orchestrator.readWorkItem(
						state.activePlanId,
						state.activeWorkItemId,
					)
				: null;
			const decision = decidePlannerNextAction({
				state,
				repo,
				recovery,
				memory: memory.dirty,
				plan,
				workItem,
			});

			if (decision.status === "compact_pending") {
				return this.result({
					status: "compact_pending",
					message: decision.message,
					state,
					repo,
					recovery,
					memory,
					decision,
					plan,
					workItem,
				});
			}

			if (decision.status === "recovery_required") {
				return this.result({
					status: "recovery_required",
					message: decision.message,
					state,
					repo,
					recovery,
					memory,
					decision,
					plan,
					workItem,
				});
			}

			if (decision.status === "memory_refresh_required") {
				return this.result({
					status: "memory_refresh_required",
					message: decision.message,
					state,
					repo,
					recovery,
					memory,
					decision,
					plan,
					workItem,
				});
			}

			if (decision.status === "compact_required") {
				return this.result({
					status: "compact_required",
					message: decision.message,
					state,
					repo,
					recovery,
					memory,
					decision,
					plan,
					workItem,
					nextPrompt: workItem
						? this.orchestrator.buildWorkItemStagePrompt(
								state.activePlanId,
								workItem.workItemId,
							)
						: this.orchestrator.buildPlanStagePrompt(state.activePlanId),
				});
			}

			if (state.activeWorkItemId) {
				if (!workItem) {
					throw new Error(
						`Active work item not found: ${state.activeWorkItemId}`,
					);
				}
				return this.result({
					status: "ready",
					message: decision.message,
					state,
					repo,
					recovery,
					memory,
					decision,
					plan,
					workItem,
					nextPrompt: this.orchestrator.buildWorkItemStagePrompt(
						state.activePlanId,
						state.activeWorkItemId,
					),
				});
			}

			return this.result({
				status: "ready",
				message: decision.message,
				state,
				repo,
				recovery,
				memory,
				decision,
				plan,
				nextPrompt: this.orchestrator.buildPlanStagePrompt(state.activePlanId),
			});
		} catch (error) {
			const decision = decidePlannerNextAction({
				state,
				repo,
				recovery: {
					status: "pending_operation",
					requiresRecovery: true,
					message:
						error instanceof Error
							? `Planner storage recovery required: ${error.message}`
							: "Planner storage recovery required.",
					currentBranch: recovery.currentBranch,
					expectedBranch: recovery.expectedBranch,
				},
				memory: memory.dirty,
			});
			return this.result({
				status: "recovery_required",
				message: decision.message,
				state,
				repo,
				recovery: decision.recovery,
				memory,
				decision,
			});
		}
	}

	private memorySnapshot(
		state: PlannerRuntimeState,
		repo: RepoState,
	): PlannerRuntimeInspection["memory"] {
		const dirty =
			this.memory && this.memorySettings
				? syncDirtyMemoryFromRepo({
						plannerState: state,
						memory: this.memory.store,
						repo,
						settings: this.memorySettings,
					}).dirty
				: (this.memory?.store.getDirtyFiles() ?? { files: {} });
		return {
			dirty,
			hasDirtyFiles: Object.keys(dirty.files).length > 0,
		};
	}

	private result(
		input: Omit<PlannerRuntimeInspection, "plan" | "workItem" | "nextPrompt"> &
			Partial<
				Pick<PlannerRuntimeInspection, "plan" | "workItem" | "nextPrompt">
			>,
	): PlannerRuntimeInspection {
		return {
			...input,
			plan: input.plan ?? null,
			workItem: input.workItem ?? null,
			nextPrompt: input.nextPrompt ?? null,
		};
	}
}
