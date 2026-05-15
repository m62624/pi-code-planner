export type PlanStatus =
	| "draft"
	| "active"
	| "blocked"
	| "completed"
	| "cancelled"
	| "archived";

export type WorkItemStatus =
	| "pending"
	| "active"
	| "review"
	| "completed"
	| "blocked"
	| "failed"
	| "skipped";

export type ExperimentAttemptStatus =
	| "created"
	| "active"
	| "candidate"
	| "selected"
	| "rejected"
	| "deleted";

export interface ProjectRecord {
	version: 1;
	projectKey: string;
	name: string;
	rootPath: string;
	createdAt: string;
	updatedAt: string;
}

export interface PlanRecord {
	version: 1;
	projectKey: string;
	planId: string;
	title: string;
	status: PlanStatus;
	createdAt: string;
	updatedAt: string;
}

export interface WorkItemRecord {
	version: 1;
	planId: string;
	workItemId: string;
	title: string;
	status: WorkItemStatus;
	createdAt: string;
	updatedAt: string;
}

export interface ExperimentAttemptRecord {
	version: 1;
	planId: string;
	workItemId: string;
	attemptId: string;
	status: ExperimentAttemptStatus;
	createdAt: string;
	updatedAt: string;
}
