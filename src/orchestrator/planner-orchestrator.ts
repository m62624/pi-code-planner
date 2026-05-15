import type {
	CompactContext,
	CompactionCoordinator,
	CompactRequestResult,
} from "../compaction/coordinator";
import type { GitCore } from "../git/core";
import type { RuntimeStateManager } from "../planner-state/runtime";
import type { PendingPlannerCompact } from "../planner-state/schema";
import type { PlanRecord, WorkItemRecord } from "../storage/schema";
import { type CreateWorkItemInput, PlanStore } from "../storage/store";
import {
	WorkflowManager,
	type WorkflowTransitionResult,
} from "../workflow/manager";
import type { PlanStage, WorkItemStage } from "../workflow/schema";

export interface PlannerOrchestratorOptions {
	projectPath: string;
	store: PlanStore;
	workflow: WorkflowManager;
	runtime: RuntimeStateManager;
	compactor: CompactionCoordinator;
}

export interface CreatePlannerPlanInput {
	title: string;
	planId?: string;
}

export interface RequestPlannerCompactInput {
	customInstructions: string;
	resumePrompt: string;
	attachToNextTurn?: boolean;
	autoResume?: boolean;
}

export interface RequestWorkItemCompactInput
	extends RequestPlannerCompactInput {
	workItemId: string;
}

export function createPlannerOrchestrator(
	core: Pick<GitCore, "paths" | "fs" | "state">,
	projectPath: string,
	compactor: CompactionCoordinator,
): PlannerOrchestrator {
	const store = new PlanStore({
		paths: core.paths,
		fs: core.fs,
	});
	return new PlannerOrchestrator({
		projectPath,
		store,
		workflow: new WorkflowManager(store),
		runtime: core.state,
		compactor,
	});
}

export class PlannerOrchestrator {
	constructor(private options: PlannerOrchestratorOptions) {}

	createPlan(input: CreatePlannerPlanInput): PlanRecord {
		const plan = this.options.store.createPlan(this.options.projectPath, {
			title: input.title,
			planId: input.planId,
		});
		this.activatePlan(plan.planId);
		return plan;
	}

	transitionPlan(
		planId: string,
		to: PlanStage,
	): WorkflowTransitionResult<PlanRecord, PlanStage> {
		const result = this.options.workflow.transitionPlan(
			this.options.projectPath,
			planId,
			to,
		);
		this.updateRuntimeForPlan(result.current);
		return result;
	}

	createWorkItem(planId: string, input: CreateWorkItemInput): WorkItemRecord {
		return this.options.store.createWorkItem(
			this.options.projectPath,
			planId,
			input,
		);
	}

	transitionWorkItem(
		planId: string,
		workItemId: string,
		to: WorkItemStage,
	): WorkflowTransitionResult<WorkItemRecord, WorkItemStage> {
		const result = this.options.workflow.transitionWorkItem(
			this.options.projectPath,
			planId,
			workItemId,
			to,
		);
		this.updateRuntimeForWorkItem(result.current);
		return result;
	}

	requestDiscoveryCompact(
		ctx: Pick<CompactContext, "compact">,
		planId: string,
		input: RequestPlannerCompactInput,
	): CompactRequestResult {
		this.transitionPlan(planId, "discovery_compact_required");
		return this.options.compactor.requestCompact(ctx, {
			reason: "discovery",
			activePlanId: planId,
			activeWorkItemId: null,
			...input,
		});
	}

	completeDiscoveryCompact(
		planId: string,
	): WorkflowTransitionResult<PlanRecord, PlanStage> {
		this.requireNoActiveCompact();
		return this.transitionPlan(planId, "post_discovery_questions");
	}

	requestWorkItemCompact(
		ctx: Pick<CompactContext, "compact">,
		planId: string,
		input: RequestWorkItemCompactInput,
	): CompactRequestResult {
		this.transitionWorkItem(
			planId,
			input.workItemId,
			"work_item_compact_required",
		);
		return this.options.compactor.requestCompact(ctx, {
			reason: "work_item",
			activePlanId: planId,
			activeWorkItemId: input.workItemId,
			customInstructions: input.customInstructions,
			resumePrompt: input.resumePrompt,
			attachToNextTurn: input.attachToNextTurn,
			autoResume: input.autoResume,
		});
	}

	completeWorkItemCompact(
		planId: string,
		workItemId: string,
	): WorkflowTransitionResult<WorkItemRecord, WorkItemStage> {
		this.requireNoActiveCompact();
		return this.transitionWorkItem(planId, workItemId, "completed");
	}

	private activatePlan(planId: string): void {
		this.options.runtime.update((state) => ({
			...state,
			mode: "plan_active",
			activePlanId: planId,
			activeWorkItemId: null,
		}));
	}

	private updateRuntimeForPlan(plan: PlanRecord): void {
		if (plan.stage === "plan_completed" || plan.stage === "plan_cancelled") {
			this.options.runtime.sleep();
			return;
		}
		this.options.runtime.update((state) => ({
			...state,
			mode:
				plan.stage === "recovery_required"
					? "recovery_required"
					: "plan_active",
			activePlanId: plan.planId,
		}));
	}

	private updateRuntimeForWorkItem(workItem: WorkItemRecord): void {
		this.options.runtime.update((state) => ({
			...state,
			mode:
				workItem.stage === "blocked" || workItem.stage === "failed"
					? "recovery_required"
					: state.mode,
			activeWorkItemId: isTerminalWorkItemStage(workItem.stage)
				? null
				: workItem.workItemId,
		}));
	}

	private requireNoActiveCompact(): void {
		const pending = this.options.compactor.getPending();
		if (pending?.status === "requested" || pending?.status === "completed") {
			throw new PlannerOrchestratorBlockedByCompact(pending);
		}
	}
}

export class PlannerOrchestratorBlockedByCompact extends Error {
	constructor(public pending: PendingPlannerCompact) {
		super(`Planner compact is still pending: ${pending.id}.`);
	}
}

function isTerminalWorkItemStage(stage: WorkItemStage): boolean {
	return (
		stage === "completed" ||
		stage === "failed" ||
		stage === "skipped" ||
		stage === "blocked"
	);
}
