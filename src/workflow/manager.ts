import type {
	ExperimentAttemptRecord,
	PlanRecord,
	WorkItemRecord,
} from "../storage/schema";
import type { PlanStore } from "../storage/store";
import type {
	AttemptStage,
	PlanStage,
	WorkflowTransitionDecision,
	WorkItemStage,
} from "./schema";
import {
	deriveAttemptStatus,
	derivePlanStatus,
	deriveWorkItemStatus,
} from "./status";
import {
	canTransitionAttempt,
	canTransitionPlan,
	canTransitionWorkItem,
} from "./transitions";

export class WorkflowTransitionRejected extends Error {
	constructor(
		public decision: WorkflowTransitionDecision<
			PlanStage | WorkItemStage | AttemptStage
		>,
	) {
		super(decision.reason);
	}
}

export interface WorkflowTransitionResult<TRecord, TStage extends string> {
	previous: TRecord;
	current: TRecord;
	decision: WorkflowTransitionDecision<TStage>;
}

export class WorkflowManager {
	constructor(private store: PlanStore) {}

	transitionPlan(
		projectPath: string,
		planId: string,
		to: PlanStage,
	): WorkflowTransitionResult<PlanRecord, PlanStage> {
		const previous = this.store.readPlan(projectPath, planId);
		const decision = canTransitionPlan(previous.stage, to);
		if (!decision.allowed) {
			throw new WorkflowTransitionRejected(decision);
		}

		const current = this.store.updatePlan(projectPath, planId, {
			stage: to,
			status: derivePlanStatus(to),
		});
		return { previous, current, decision };
	}

	transitionWorkItem(
		projectPath: string,
		planId: string,
		workItemId: string,
		to: WorkItemStage,
	): WorkflowTransitionResult<WorkItemRecord, WorkItemStage> {
		const previous = this.store.readWorkItem(projectPath, planId, workItemId);
		const decision = canTransitionWorkItem(previous.stage, to);
		if (!decision.allowed) {
			throw new WorkflowTransitionRejected(decision);
		}

		const current = this.store.updateWorkItem(projectPath, planId, workItemId, {
			stage: to,
			status: deriveWorkItemStatus(to),
		});
		return { previous, current, decision };
	}

	transitionAttempt(
		projectPath: string,
		planId: string,
		workItemId: string,
		attemptId: string,
		to: AttemptStage,
	): WorkflowTransitionResult<ExperimentAttemptRecord, AttemptStage> {
		const previous = this.store.readAttempt(
			projectPath,
			planId,
			workItemId,
			attemptId,
		);
		const decision = canTransitionAttempt(previous.stage, to);
		if (!decision.allowed) {
			throw new WorkflowTransitionRejected(decision);
		}

		const current = this.store.updateAttempt(
			projectPath,
			planId,
			workItemId,
			attemptId,
			{
				stage: to,
				status: deriveAttemptStatus(to),
			},
		);
		return { previous, current, decision };
	}
}
