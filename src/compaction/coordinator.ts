import type { RuntimeStateManager } from "../planner-state/runtime";
import type {
	PendingPlannerCompact,
	PlannerCompactReason,
} from "../planner-state/schema";

export interface CompactContext {
	compact(options: {
		customInstructions?: string;
		onComplete?: () => void;
		onError?: (error: Error) => void;
	}): void;
	isIdle(): boolean;
	hasPendingMessages(): boolean;
}

export interface ResumeMessenger {
	sendUserMessage(
		content: string,
		options?: { deliverAs?: "steer" | "followUp" },
	): void;
}

export interface RequestCompactInput {
	reason: PlannerCompactReason;
	customInstructions: string;
	resumePrompt: string;
	activePlanId?: string | null;
	activeWorkItemId?: string | null;
	attachToNextTurn?: boolean;
	autoResume?: boolean;
}

export interface AutoResumeInput {
	ctx: Pick<CompactContext, "isIdle" | "hasPendingMessages">;
	messenger: ResumeMessenger;
}

export interface CompactionCoordinatorOptions {
	state: RuntimeStateManager;
	now?: () => string;
	createId?: () => string;
}

export type CompactRequestResult =
	| { kind: "started"; pending: PendingPlannerCompact }
	| { kind: "already_pending"; pending: PendingPlannerCompact };

export class CompactionCoordinator {
	private now: () => string;
	private createId: () => string;

	constructor(private options: CompactionCoordinatorOptions) {
		this.now = options.now ?? (() => new Date().toISOString());
		this.createId =
			options.createId ??
			(() =>
				`compact-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
	}

	requestCompact(
		ctx: Pick<CompactContext, "compact">,
		input: RequestCompactInput,
	): CompactRequestResult {
		const current = this.options.state.get().pendingCompact;
		if (current?.status === "requested" || current?.status === "completed") {
			return { kind: "already_pending", pending: current };
		}

		const pending: PendingPlannerCompact = {
			id: this.createId(),
			reason: input.reason,
			status: "requested",
			requestedAt: this.now(),
			completedAt: null,
			failedAt: null,
			error: null,
			activePlanId: input.activePlanId ?? this.options.state.get().activePlanId,
			activeWorkItemId:
				input.activeWorkItemId ?? this.options.state.get().activeWorkItemId,
			customInstructions: input.customInstructions,
			resumePrompt: input.resumePrompt,
			attachToNextTurn: input.attachToNextTurn ?? true,
			autoResume: input.autoResume ?? true,
		};

		this.options.state.update((state) => ({
			...state,
			pendingCompact: pending,
		}));

		ctx.compact({
			customInstructions: input.customInstructions,
			onComplete: () => this.markCompleted(pending.id),
			onError: (error) => this.markFailed(pending.id, error),
		});

		return { kind: "started", pending };
	}

	markCompleted(id: string): PendingPlannerCompact | null {
		let nextPending: PendingPlannerCompact | null = null;
		this.options.state.update((state) => {
			if (state.pendingCompact?.id !== id) return state;
			nextPending = {
				...state.pendingCompact,
				status: "completed",
				completedAt: this.now(),
				failedAt: null,
				error: null,
			};
			return {
				...state,
				pendingCompact: nextPending,
			};
		});
		return nextPending;
	}

	markFailed(id: string, error: Error): PendingPlannerCompact | null {
		let nextPending: PendingPlannerCompact | null = null;
		this.options.state.update((state) => {
			if (state.pendingCompact?.id !== id) return state;
			nextPending = {
				...state.pendingCompact,
				status: "failed",
				failedAt: this.now(),
				error: error.message,
			};
			return {
				...state,
				mode: "recovery_required",
				pendingCompact: nextPending,
			};
		});
		return nextPending;
	}

	consumeResumeInstructionForNextTurn(): string | null {
		let resumePrompt: string | null = null;
		this.options.state.update((state) => {
			const pending = state.pendingCompact;
			if (
				!pending ||
				pending.status !== "completed" ||
				!pending.attachToNextTurn
			) {
				return state;
			}

			resumePrompt = pending.resumePrompt;
			return {
				...state,
				pendingCompact: null,
			};
		});
		return resumePrompt;
	}

	sendAutoResumeIfIdle(input: AutoResumeInput): boolean {
		const pending = this.options.state.get().pendingCompact;
		if (!pending || pending.status !== "completed" || !pending.autoResume) {
			return false;
		}
		if (!input.ctx.isIdle() || input.ctx.hasPendingMessages()) {
			return false;
		}

		this.options.state.update((state) => {
			if (state.pendingCompact?.id !== pending.id) return state;
			return {
				...state,
				pendingCompact: null,
			};
		});
		input.messenger.sendUserMessage(pending.resumePrompt, {
			deliverAs: "followUp",
		});
		return true;
	}

	getPending(): PendingPlannerCompact | null {
		return this.options.state.get().pendingCompact;
	}
}
