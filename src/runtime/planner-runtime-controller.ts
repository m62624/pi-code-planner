import type { GitRecoveryAnalysis } from "../git/recovery";
import { analyzeGitRecovery } from "../git/recovery";
import type { RepoState } from "../git/state";
import type { PlannerOrchestrator } from "../orchestrator/planner-orchestrator";
import type { RuntimeStateManager } from "../planner-state/runtime";
import type { PlannerRuntimeState } from "../planner-state/schema";
import type { AssemblePlannerPromptResult } from "../prompts/assembler";
import type { PlanRecord, WorkItemRecord } from "../storage/schema";

export type PlannerRuntimeStatus =
	| "idle"
	| "ready"
	| "compact_pending"
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
	plan: PlanRecord | null;
	workItem: WorkItemRecord | null;
	nextPrompt: AssemblePlannerPromptResult | null;
}

export class PlannerRuntimeController {
	constructor(
		private core: PlannerRuntimeControllerCore,
		private orchestrator: PlannerOrchestrator,
	) {}

	async inspect(): Promise<PlannerRuntimeInspection> {
		const state = this.core.state.get();
		const repo = await this.core.readRepoState();
		const recovery = analyzeGitRecovery(state, repo);

		if (recovery.status === "inactive") {
			return this.result({
				status: "idle",
				message: "Planner is idle.",
				state,
				repo,
				recovery,
			});
		}

		const pendingCompact = state.pendingCompact;
		if (
			pendingCompact?.status === "requested" ||
			pendingCompact?.status === "completed"
		) {
			return this.result({
				status: "compact_pending",
				message: `Planner compact is pending: ${pendingCompact.id}.`,
				state,
				repo,
				recovery,
			});
		}

		if (recovery.requiresRecovery) {
			return this.result({
				status: "recovery_required",
				message: recovery.message,
				state,
				repo,
				recovery,
			});
		}

		return this.activeResult(state, repo, recovery);
	}

	private activeResult(
		state: PlannerRuntimeState,
		repo: RepoState,
		recovery: GitRecoveryAnalysis,
	): PlannerRuntimeInspection {
		if (!state.activePlanId) {
			return this.result({
				status: "recovery_required",
				message: "Planner runtime is active without an active plan id.",
				state,
				repo,
				recovery,
			});
		}

		try {
			const plan = this.orchestrator.readPlan(state.activePlanId);
			if (state.activeWorkItemId) {
				const workItem = this.orchestrator.readWorkItem(
					state.activePlanId,
					state.activeWorkItemId,
				);
				return this.result({
					status: "ready",
					message: `Planner is ready at work item stage: ${workItem.stage}.`,
					state,
					repo,
					recovery,
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
				message: `Planner is ready at plan stage: ${plan.stage}.`,
				state,
				repo,
				recovery,
				plan,
				nextPrompt: this.orchestrator.buildPlanStagePrompt(state.activePlanId),
			});
		} catch (error) {
			return this.result({
				status: "recovery_required",
				message:
					error instanceof Error
						? `Planner storage recovery required: ${error.message}`
						: "Planner storage recovery required.",
				state,
				repo,
				recovery,
			});
		}
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
