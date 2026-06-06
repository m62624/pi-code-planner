import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { PlannerFs } from "../storage/fs";

export interface PlannerHandoffSession {
	sessionDir: string;
	sessionFile: string;
	header: PiSessionHeader;
}

export interface PiSessionHeader {
	type: "session";
	version: 3;
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
}

export interface PlannerResumeSessionCandidate {
	path: string;
	messageCount: number;
}

export function selectPlannerResumeSessionFile(
	sessions: readonly PlannerResumeSessionCandidate[],
): string | null {
	return (
		sessions.find((session) => session.messageCount > 0)?.path ??
		sessions[0]?.path ??
		null
	);
}

export async function createPlannerHandoffSession(input: {
	fs: PlannerFs;
	agentDir: string;
	worktreePath: string;
	parentSession?: string | null;
	now?: Date;
	sessionId?: string;
}): Promise<PlannerHandoffSession> {
	const timestamp = (input.now ?? new Date()).toISOString();
	const sessionId = input.sessionId ?? randomUUID();
	const sessionDir = createPiSessionDir({
		agentDir: input.agentDir,
		cwd: input.worktreePath,
	});
	const sessionFile = join(
		sessionDir,
		`${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`,
	);
	const header: PiSessionHeader = {
		type: "session",
		version: 3,
		id: sessionId,
		timestamp,
		cwd: input.worktreePath,
		...(input.parentSession ? { parentSession: input.parentSession } : {}),
	};

	await input.fs.mkdirp(sessionDir);
	await input.fs.writeTextAtomic(sessionFile, `${JSON.stringify(header)}\n`);
	return { sessionDir, sessionFile, header };
}

export async function removePlannerHandoffBootstrapFile(
	fs: PlannerFs,
	sessionFile: string,
): Promise<void> {
	await fs.removeFile(sessionFile);
}

export function createPiSessionDir(input: {
	agentDir: string;
	cwd: string;
}): string {
	const safePath = `--${input.cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(input.agentDir, "sessions", safePath);
}

export function buildPlannerHandoffPrompt(input: {
	planId: string;
	worktreePath: string;
	descriptionLanguage?: string;
}): string {
	const descriptionLanguage = input.descriptionLanguage ?? "English";
	return [
		`Planner plan ${input.planId} was created and this session is now in the planner worktree.`,
		`Worktree: ${input.worktreePath}`,
		`Planner-list description language: ${descriptionLanguage}`,
		"",
		"Call planner_status now.",
		"Read request.md, draft the requested goal content in your own words, then call planner_goal_submit.",
		"Do not edit goal.md directly with built-in write/edit tools; planner_goal_submit writes goal.md.",
		`When calling planner_goal_submit, generate the short planner-list description in ${descriptionLanguage}.`,
		"Show the full goal draft to the user and wait for explicit approval.",
		"Do not write plan.md yet. plan.md is written later during planning/draft_plan after discovery and questions are complete.",
		"Wait for explicit user approval. Ask evidence-based clarification questions only after discovery.",
		"Do not inspect project source before planner_status reports discovery/scan_project_structure.",
		"Do not use raw git while the planner plan is active.",
	].join("\n");
}

export function buildPlannerResumePrompt(input: {
	planId: string;
	worktreePath: string;
}): string {
	return [
		`Planner plan ${input.planId} is now active and this session is in its planner worktree.`,
		`Worktree: ${input.worktreePath}`,
		"",
		"Call planner_status now.",
		"Resume only from the stage/step reported by planner_status.",
		"Do not use raw git while the planner plan is active.",
	].join("\n");
}
