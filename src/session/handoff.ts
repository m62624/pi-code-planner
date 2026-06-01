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
}

export async function createPlannerHandoffSession(input: {
	fs: PlannerFs;
	agentDir: string;
	worktreePath: string;
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
	};

	await input.fs.mkdirp(sessionDir);
	return { sessionDir, sessionFile, header };
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
}): string {
	return [
		`Planner plan ${input.planId} was created and this session is now in the planner worktree.`,
		`Worktree: ${input.worktreePath}`,
		"",
		"Call planner_status now.",
		"Draft the requested goal in goal.md using your own words.",
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
