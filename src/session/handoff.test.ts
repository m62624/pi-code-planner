import { describe, expect, it } from "vitest";
import { MockPlannerFs } from "../test/mock-fs";
import {
	buildPlannerHandoffPrompt,
	buildPlannerResumePrompt,
	createPiSessionDir,
	createPlannerHandoffSession,
	removePlannerHandoffBootstrapFile,
} from "./handoff";

describe("planner session handoff", () => {
	it("writes a valid Pi session jsonl header for the worktree cwd", async () => {
		const fs = new MockPlannerFs();

		const session = await createPlannerHandoffSession({
			fs,
			agentDir: "/agent",
			worktreePath: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
			parentSession: "/agent/sessions/original.jsonl",
			now: new Date("2026-05-25T06:00:00.000Z"),
			sessionId: "session-1",
		});

		expect(session.sessionDir).toBe(
			"/agent/sessions/--repo-app-.pi-pi-code-planner-worktrees-plan-a--",
		);
		expect(session.sessionFile).toBe(
			"/agent/sessions/--repo-app-.pi-pi-code-planner-worktrees-plan-a--/2026-05-25T06-00-00-000Z_session-1.jsonl",
		);
		expect(session.header).toEqual({
			type: "session",
			version: 3,
			id: "session-1",
			timestamp: "2026-05-25T06:00:00.000Z",
			cwd: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
			parentSession: "/agent/sessions/original.jsonl",
		});
		expect(fs.snapshot()[session.sessionFile]).toBe(
			`${JSON.stringify(session.header)}\n`,
		);

		await removePlannerHandoffBootstrapFile(fs, session.sessionFile);
		expect(fs.snapshot()[session.sessionFile]).toBeUndefined();
	});

	it("omits the optional parent session when no origin exists", async () => {
		const fs = new MockPlannerFs();

		const session = await createPlannerHandoffSession({
			fs,
			agentDir: "/agent",
			worktreePath: "/repo/worktree",
			now: new Date("2026-05-25T06:00:00.000Z"),
			sessionId: "session-1",
		});

		expect(JSON.stringify(session.header)).toBe(
			JSON.stringify({
				type: "session",
				version: 3,
				id: "session-1",
				timestamp: "2026-05-25T06:00:00.000Z",
				cwd: "/repo/worktree",
			}),
		);
	});

	it("uses the same safe session directory shape as Pi", () => {
		expect(
			createPiSessionDir({
				agentDir: "/agent",
				cwd: "C:\\repo\\app",
			}),
		).toBe("/agent/sessions/--C--repo-app--");
	});

	it("builds the first worktree-session prompt", () => {
		expect(
			buildPlannerHandoffPrompt({
				planId: "plan-a",
				worktreePath: "/repo/worktree",
			}),
		).toContain("Call planner_status now.");
	});

	it("builds the resume prompt for switching between planner worktrees", () => {
		expect(
			buildPlannerResumePrompt({
				planId: "plan-b",
				worktreePath: "/repo/worktree-b",
			}),
		).toContain("Resume only from the stage/step reported by planner_status.");
	});
});
