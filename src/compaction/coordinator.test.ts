import { describe, expect, it, vi } from "vitest";
import { RuntimeStateManager } from "../planner-state/runtime";
import { createSettingsPaths } from "../settings/paths";
import { MemoryFs } from "../test/memory-fs";
import {
	type CompactContext,
	CompactionCoordinator,
	type ResumeMessenger,
} from "./coordinator";

const paths = createSettingsPaths({
	agentDir: "/agent",
	cwd: "/repo",
	extensionName: "pi-planner",
});

function createHarness() {
	const fs = new MemoryFs();
	const state = new RuntimeStateManager({ paths, fs });
	state.initialize();
	state.update((current) => ({
		...current,
		mode: "plan_active",
		activePlanId: "plan-1",
		activeWorkItemId: "work-1",
	}));

	let tick = 0;
	const coordinator = new CompactionCoordinator({
		state,
		now: () => `2026-05-15T00:00:0${tick++}.000Z`,
		createId: () => "compact-1",
	});

	const ctx: CompactContext = {
		compact: vi.fn(),
		isIdle: vi.fn(() => true),
		hasPendingMessages: vi.fn(() => false),
	};
	const messenger: ResumeMessenger = {
		sendUserMessage: vi.fn(),
	};

	return { coordinator, ctx, fs, messenger, state };
}

function requestDefaultCompact(
	coordinator: CompactionCoordinator,
	ctx: CompactContext,
) {
	return coordinator.requestCompact(ctx, {
		reason: "work_item",
		customInstructions: "compact this work item",
		resumePrompt: "resume planner work",
	});
}

describe("CompactionCoordinator", () => {
	it("persists pending compact before calling Pi compact", () => {
		const { coordinator, ctx, state } = createHarness();

		const result = requestDefaultCompact(coordinator, ctx);

		expect(result.kind).toBe("started");
		expect(state.get().pendingCompact).toMatchObject({
			id: "compact-1",
			reason: "work_item",
			status: "requested",
			activePlanId: "plan-1",
			activeWorkItemId: "work-1",
			customInstructions: "compact this work item",
			resumePrompt: "resume planner work",
			attachToNextTurn: true,
			autoResume: true,
		});
		expect(ctx.compact).toHaveBeenCalledWith({
			customInstructions: "compact this work item",
			onComplete: expect.any(Function),
			onError: expect.any(Function),
		});
	});

	it("marks compact completed from the Pi callback without sending resume", () => {
		const { coordinator, ctx, messenger, state } = createHarness();
		requestDefaultCompact(coordinator, ctx);
		const compactCall = vi.mocked(ctx.compact).mock.calls[0][0];

		compactCall.onComplete?.();

		expect(state.get().pendingCompact).toMatchObject({
			id: "compact-1",
			status: "completed",
			completedAt: "2026-05-15T00:00:01.000Z",
		});
		expect(messenger.sendUserMessage).not.toHaveBeenCalled();
	});

	it("stores compact failures for recovery", () => {
		const { coordinator, ctx, state } = createHarness();
		requestDefaultCompact(coordinator, ctx);
		const compactCall = vi.mocked(ctx.compact).mock.calls[0][0];

		compactCall.onError?.(new Error("compact failed"));

		expect(state.get()).toMatchObject({
			mode: "recovery_required",
			pendingCompact: {
				id: "compact-1",
				status: "failed",
				failedAt: "2026-05-15T00:00:01.000Z",
				error: "compact failed",
			},
		});
	});

	it("attaches completed resume to the next turn and clears pending state", () => {
		const { coordinator, ctx, state } = createHarness();
		requestDefaultCompact(coordinator, ctx);
		coordinator.markCompleted("compact-1");

		const resume = coordinator.consumeResumeInstructionForNextTurn();

		expect(resume).toBe("resume planner work");
		expect(state.get().pendingCompact).toBeNull();
	});

	it("does not attach resume before compact completes", () => {
		const { coordinator, ctx, state } = createHarness();
		requestDefaultCompact(coordinator, ctx);

		expect(coordinator.consumeResumeInstructionForNextTurn()).toBeNull();
		expect(state.get().pendingCompact?.status).toBe("requested");
	});

	it("does not auto-resume while user or agent messages are pending", () => {
		const { coordinator, ctx, messenger, state } = createHarness();
		requestDefaultCompact(coordinator, ctx);
		coordinator.markCompleted("compact-1");
		vi.mocked(ctx.hasPendingMessages).mockReturnValue(true);

		const sent = coordinator.sendAutoResumeIfIdle({ ctx, messenger });

		expect(sent).toBe(false);
		expect(messenger.sendUserMessage).not.toHaveBeenCalled();
		expect(state.get().pendingCompact?.status).toBe("completed");
	});

	it("auto-resumes only when idle and clears pending state", () => {
		const { coordinator, ctx, messenger, state } = createHarness();
		requestDefaultCompact(coordinator, ctx);
		coordinator.markCompleted("compact-1");

		const sent = coordinator.sendAutoResumeIfIdle({ ctx, messenger });

		expect(sent).toBe(true);
		expect(messenger.sendUserMessage).toHaveBeenCalledWith(
			"resume planner work",
			{ deliverAs: "followUp" },
		);
		expect(state.get().pendingCompact).toBeNull();
	});

	it("rejects a second compact while resume is pending", () => {
		const { coordinator, ctx } = createHarness();
		requestDefaultCompact(coordinator, ctx);
		coordinator.markCompleted("compact-1");

		const second = coordinator.requestCompact(ctx, {
			reason: "manual",
			customInstructions: "another compact",
			resumePrompt: "another resume",
		});

		expect(second.kind).toBe("already_pending");
		expect(ctx.compact).toHaveBeenCalledTimes(1);
	});
});
