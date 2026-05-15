import type { PlannerFs } from "../settings/fs";
import type { SettingsPaths } from "../settings/paths";
import {
	getAttemptStoragePaths,
	getPlanStoragePaths,
	getWorkItemStoragePaths,
} from "../storage/paths";

export type PlanArtifactName = "plan" | "discovery" | "questions" | "decisions";

export type WorkItemArtifactName =
	| "tdd_plan"
	| "tests_summary"
	| "refactor_notes";

export type AttemptArtifactName =
	| "plan"
	| "prompt"
	| "summary"
	| "score"
	| "verification"
	| "changed_files";

export interface PlannerArtifactOptions {
	paths: Pick<SettingsPaths, "globalDir">;
	fs: PlannerFs;
}

export interface ArtifactReadResult<TName extends string> {
	name: TName;
	path: string;
	content: string;
	exists: boolean;
}

export class PlannerArtifacts {
	constructor(private options: PlannerArtifactOptions) {}

	getPlanArtifactPath(
		projectPath: string,
		planId: string,
		name: PlanArtifactName,
	): string {
		const paths = getPlanStoragePaths({
			paths: this.options.paths,
			projectPath,
			planId,
		});
		const artifactPaths: Record<PlanArtifactName, string> = {
			plan: paths.planMarkdown,
			discovery: paths.planDiscovery,
			questions: paths.planQuestions,
			decisions: paths.planDecisions,
		};
		return artifactPaths[name];
	}

	readPlanArtifact(
		projectPath: string,
		planId: string,
		name: PlanArtifactName,
	): ArtifactReadResult<PlanArtifactName> {
		return this.readArtifact(
			name,
			this.getPlanArtifactPath(projectPath, planId, name),
		);
	}

	writePlanArtifact(
		projectPath: string,
		planId: string,
		name: PlanArtifactName,
		content: string,
	): ArtifactReadResult<PlanArtifactName> {
		return this.writeArtifact(
			name,
			this.getPlanArtifactPath(projectPath, planId, name),
			content,
		);
	}

	appendPlanArtifact(
		projectPath: string,
		planId: string,
		name: PlanArtifactName,
		content: string,
	): ArtifactReadResult<PlanArtifactName> {
		return this.appendArtifact(
			name,
			this.getPlanArtifactPath(projectPath, planId, name),
			content,
		);
	}

	getWorkItemArtifactPath(
		projectPath: string,
		planId: string,
		workItemId: string,
		name: WorkItemArtifactName,
	): string {
		const paths = getWorkItemStoragePaths({
			paths: this.options.paths,
			projectPath,
			planId,
			workItemId,
		});
		const artifactPaths: Record<WorkItemArtifactName, string> = {
			tdd_plan: paths.workItemTddPlan,
			tests_summary: paths.workItemTestsSummary,
			refactor_notes: paths.workItemRefactorNotes,
		};
		return artifactPaths[name];
	}

	readWorkItemArtifact(
		projectPath: string,
		planId: string,
		workItemId: string,
		name: WorkItemArtifactName,
	): ArtifactReadResult<WorkItemArtifactName> {
		return this.readArtifact(
			name,
			this.getWorkItemArtifactPath(projectPath, planId, workItemId, name),
		);
	}

	writeWorkItemArtifact(
		projectPath: string,
		planId: string,
		workItemId: string,
		name: WorkItemArtifactName,
		content: string,
	): ArtifactReadResult<WorkItemArtifactName> {
		return this.writeArtifact(
			name,
			this.getWorkItemArtifactPath(projectPath, planId, workItemId, name),
			content,
		);
	}

	appendWorkItemArtifact(
		projectPath: string,
		planId: string,
		workItemId: string,
		name: WorkItemArtifactName,
		content: string,
	): ArtifactReadResult<WorkItemArtifactName> {
		return this.appendArtifact(
			name,
			this.getWorkItemArtifactPath(projectPath, planId, workItemId, name),
			content,
		);
	}

	getAttemptArtifactPath(
		projectPath: string,
		planId: string,
		workItemId: string,
		attemptId: string,
		name: AttemptArtifactName,
	): string {
		const paths = getAttemptStoragePaths({
			paths: this.options.paths,
			projectPath,
			planId,
			workItemId,
			attemptId,
		});
		const artifactPaths: Record<AttemptArtifactName, string> = {
			plan: paths.attemptPlan,
			prompt: paths.attemptPrompt,
			summary: paths.attemptSummary,
			score: paths.attemptScore,
			verification: paths.attemptVerification,
			changed_files: paths.attemptChangedFiles,
		};
		return artifactPaths[name];
	}

	readAttemptArtifact(
		projectPath: string,
		planId: string,
		workItemId: string,
		attemptId: string,
		name: AttemptArtifactName,
	): ArtifactReadResult<AttemptArtifactName> {
		return this.readArtifact(
			name,
			this.getAttemptArtifactPath(
				projectPath,
				planId,
				workItemId,
				attemptId,
				name,
			),
		);
	}

	writeAttemptArtifact(
		projectPath: string,
		planId: string,
		workItemId: string,
		attemptId: string,
		name: AttemptArtifactName,
		content: string,
	): ArtifactReadResult<AttemptArtifactName> {
		return this.writeArtifact(
			name,
			this.getAttemptArtifactPath(
				projectPath,
				planId,
				workItemId,
				attemptId,
				name,
			),
			content,
		);
	}

	appendAttemptArtifact(
		projectPath: string,
		planId: string,
		workItemId: string,
		attemptId: string,
		name: AttemptArtifactName,
		content: string,
	): ArtifactReadResult<AttemptArtifactName> {
		return this.appendArtifact(
			name,
			this.getAttemptArtifactPath(
				projectPath,
				planId,
				workItemId,
				attemptId,
				name,
			),
			content,
		);
	}

	private readArtifact<TName extends string>(
		name: TName,
		path: string,
	): ArtifactReadResult<TName> {
		if (!this.options.fs.exists(path)) {
			return { name, path, content: "", exists: false };
		}
		return {
			name,
			path,
			content: this.options.fs.readFile(path),
			exists: true,
		};
	}

	private writeArtifact<TName extends string>(
		name: TName,
		path: string,
		content: string,
	): ArtifactReadResult<TName> {
		this.options.fs.writeFile(path, content);
		return { name, path, content, exists: true };
	}

	private appendArtifact<TName extends string>(
		name: TName,
		path: string,
		content: string,
	): ArtifactReadResult<TName> {
		const previous = this.options.fs.exists(path)
			? this.options.fs.readFile(path)
			: "";
		const separator =
			previous.length === 0 || previous.endsWith("\n") ? "" : "\n";
		const next = `${previous}${separator}${content}`;
		return this.writeArtifact(name, path, next);
	}
}
