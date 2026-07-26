import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	ALL_PLANNER_TOOL_NAMES,
	PLANNER_LIFECYCLE_TRANSITION_TOOLS,
} from "./guard/tool-policy";
import { PLANNER_RECOVERY_REPORT_TOOL_NAME } from "./runtime/recovery-tools";
import type { PlannerFs } from "./storage/fs";

export interface RegisteredTool {
	name: string;
}

// The recovery report tool is treated as a planner tool for visibility (hidden
// when no plan is active) but is also gated dynamically: it stays hidden while a
// plan runs until stuck-detection unlocks it.
const plannerNames: Set<string> = new Set([
	...ALL_PLANNER_TOOL_NAMES,
	PLANNER_RECOVERY_REPORT_TOOL_NAME,
]);

let recoveryReportUnlocked = false;

/**
 * Toggle whether the recovery report tool is visible during an active plan.
 * Returns true when the value changed, so the caller can refresh visibility.
 */
export function setRecoveryReportUnlocked(unlocked: boolean): boolean {
	if (recoveryReportUnlocked === unlocked) return false;
	recoveryReportUnlocked = unlocked;
	return true;
}

export function isRecoveryReportUnlocked(): boolean {
	return recoveryReportUnlocked;
}
const PLANNER_TOOL_VISIBILITY_CUSTOM_TYPE = "planner-tool-visibility";

interface PlannerToolVisibilityState {
	active: boolean;
}

/** Cached plan active state — false by default, updated after planner commands. */
let planActiveCache: boolean = false;

/**
 * When true, restrict visible tools to contract traversal tools only.
 * Active during discovery/scan_project_structure while AGENTS.md chain is unread.
 */
let contractGateActive: boolean = false;

const CONTRACT_GATE_ALLOWED: ReadonlySet<string> = new Set<string>([
	"planner_status",
	"planner_artifact_read",
	"planner_contract_scan",
	"planner_contract_route",
	"planner_contract_read",
	// Lifecycle transitions must stay reachable, otherwise a pending step whose
	// required action is planner_start_step deadlocks: the gate would hide the
	// very tool the orchestrator demands before contract tools are unblocked.
	...PLANNER_LIFECYCLE_TRANSITION_TOOLS,
]);

export function setContractGateActive(active: boolean): void {
	contractGateActive = active;
}

export function isContractGateActive(): boolean {
	return contractGateActive;
}

export function isPlanActive(): boolean {
	return planActiveCache;
}

export function setPlanActive(active: boolean): void {
	planActiveCache = active;
}

export function activatePlannerToolVisibility(pi: ExtensionAPI): void {
	planActiveCache = true;
	updateToolVisibility(pi);
}

export function markPlannerToolVisibilityActive(): void {
	planActiveCache = true;
}

export function persistPlannerToolVisibilityActive(pi: ExtensionAPI): void {
	planActiveCache = true;
	pi.appendEntry<PlannerToolVisibilityState>(
		PLANNER_TOOL_VISIBILITY_CUSTOM_TYPE,
		{ active: true },
	);
}

export async function persistPlannerToolVisibilityActiveToSession(input: {
	fs: PlannerFs;
	sessionFile: string;
	now?: Date;
	id?: string;
}): Promise<void> {
	planActiveCache = true;
	const content = await input.fs.readText(input.sessionFile);
	const entries = content
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as { type?: string; id?: string });
	const parentId = entries
		.slice(1)
		.reverse()
		.find((entry) => typeof entry.id === "string")?.id;
	const entry = {
		type: "custom",
		customType: PLANNER_TOOL_VISIBILITY_CUSTOM_TYPE,
		data: { active: true } satisfies PlannerToolVisibilityState,
		id: input.id ?? `planner-tools-${Date.now().toString(36)}`,
		parentId: parentId ?? null,
		timestamp: (input.now ?? new Date()).toISOString(),
	};
	const nextContent = `${content.trimEnd()}\n${JSON.stringify(entry)}\n`;
	await input.fs.writeTextAtomic(input.sessionFile, nextContent);
}

export function filterPlannerTools(tools: RegisteredTool[]): RegisteredTool[] {
	return tools.filter((tool) => !plannerNames.has(tool.name));
}

/** Synchronously check if a plan is active. */
export function refreshPlanActiveCacheSync(
	pi: ExtensionAPI,
	_cwd: string,
): boolean {
	// Do NOT auto-activate plan. activePlanId is only set via
	// /planner-create or /planner-resume. On session start (including
	// resumed sessions) the plan must NOT be auto-activated.
	planActiveCache = false;
	updateToolVisibility(pi);
	return false;
}

/** Refresh the plan-active cache by reading from disk. */
export async function refreshPlanActiveCache(
	pi: ExtensionAPI,
	_cwd: string,
): Promise<boolean> {
	// Do NOT auto-activate plan. activePlanId is only set via
	// /planner-create or /planner-resume. On session start the plan
	// must NOT be auto-activated.
	planActiveCache = false;
	updateToolVisibility(pi);
	return false;
}

/** Reset the cache to inactive (called after /planner-finish, /planner-delete). */
export function resetPlanActiveCache(pi: ExtensionAPI): void {
	planActiveCache = false;
	updateToolVisibility(pi);
}

/**
 * The active tool list to apply, as a SUBTRACTION from what is already active
 * rather than a fresh statement of the whole world.
 *
 * `setActiveTools` is a global setter with no notion of whose tools are whose:
 * whoever writes last wins the entire list. We used to rebuild it from
 * `getAllTools()` on every provider request — and so does at least one other
 * extension in the same session. Two extensions each declaring the world, on
 * every request, resurrect each other's hidden tools and change the head of the
 * prompt between two calls of one turn. The head is where the tool schemas live,
 * and a prefix cache reuses exactly one thing: bytes it has already read. Change
 * byte zero and the whole prompt is re-read.
 *
 * So we state only our own invariants and leave everyone else's decisions alone:
 *
 *   next = (active now  ∪  what we claim)  \  what we hide
 *
 * This converges: our claim/hide sets are a pure function of planner state, so
 * repeating the computation yields the same list — a stable set of tools, which
 * is a stable head. Order is part of those bytes, so the result is built by
 * walking the registry, whose order does not move.
 *
 * The contract gate is the exception, and deliberately so: it is a SANDBOX, not
 * a subtraction. While it is up the model must not reach project reads at all,
 * so the list is exactly the allowlist and other extensions' tools go with it.
 */
export function computePlannerActiveTools(input: {
	allToolNames: readonly string[];
	activeNow: readonly string[];
	planActive: boolean;
	contractGate: boolean;
	recoveryReportUnlocked: boolean;
}): string[] {
	if (input.planActive && input.contractGate) {
		return input.allToolNames.filter((name) => CONTRACT_GATE_ALLOWED.has(name));
	}

	const claimed = new Set<string>();
	const hidden = new Set<string>();
	if (!input.planActive) {
		// No plan: none of our tools belong in the prompt.
		for (const name of plannerNames) hidden.add(name);
	} else {
		for (const name of plannerNames) claimed.add(name);
		if (!input.recoveryReportUnlocked) {
			claimed.delete(PLANNER_RECOVERY_REPORT_TOOL_NAME);
			hidden.add(PLANNER_RECOVERY_REPORT_TOOL_NAME);
		}
	}

	const active = new Set(input.activeNow);
	return input.allToolNames.filter(
		(name) => (active.has(name) || claimed.has(name)) && !hidden.has(name),
	);
}

/**
 * The world as it was before the contract-gate sandbox went up.
 *
 * While the sandbox is up the live list IS the sandbox, so "subtract from what is
 * active" would have almost nothing to subtract from: come out of the gate
 * reading the live list and every other extension's tools would stay hidden for
 * good. So the world is remembered on the way in and restored on the way out.
 */
let worldBeforeContractGate: string[] | null = null;

/**
 * The exact list we last wrote, or `null` before the first refresh — our own
 * footprint on a global setter.
 *
 * `setActiveTools` has no notion of whose tools are whose, so a tool list
 * arriving at the provider is not self-evidently ours: another extension may have
 * written after us. Only the writer can answer "is this what WE decided?", and
 * `runtime/prefix-watch.ts` needs the answer to tell a head we rewrote from a
 * head somebody else did.
 */
let lastSetToolNames: string[] | null = null;

export function plannerLastSetToolNames(): readonly string[] | null {
	return lastSetToolNames;
}

/** Update the list of active tools in the Pi extension API. */
export function updateToolVisibility(pi: ExtensionAPI): void {
	const allToolNames = pi.getAllTools().map((tool) => tool.name);
	const sandboxed = planActiveCache && contractGateActive;
	if (sandboxed) {
		worldBeforeContractGate ??= pi.getActiveTools();
	}
	const activeNow = sandboxed
		? []
		: (worldBeforeContractGate ?? pi.getActiveTools());
	if (!sandboxed) {
		worldBeforeContractGate = null;
	}

	const next = computePlannerActiveTools({
		allToolNames,
		activeNow,
		planActive: planActiveCache,
		contractGate: contractGateActive,
		recoveryReportUnlocked,
	});
	lastSetToolNames = next;
	pi.setActiveTools(next);
}

function restorePlannerToolVisibilityFromSession(ctx?: ExtensionContext): void {
	if (!ctx) return;
	const branchEntries = ctx.sessionManager.getBranch();
	let savedActive: boolean | undefined;

	for (const entry of branchEntries) {
		if (
			entry.type === "custom" &&
			entry.customType === PLANNER_TOOL_VISIBILITY_CUSTOM_TYPE
		) {
			const data = entry.data as PlannerToolVisibilityState | undefined;
			if (typeof data?.active === "boolean") {
				savedActive = data.active;
			}
		}
	}

	if (typeof savedActive === "boolean") {
		planActiveCache = savedActive;
	}
}

export function registerPlannerToolVisibility(pi: ExtensionAPI): void {
	// Do NOT call updateToolVisibility synchronously during extension load.
	// pi.getAllTools() / pi.setActiveTools() are action methods that cannot
	// be called during extension loading. Tool visibility will be updated
	// on session_start (first session) and before_provider_request.

	// Do NOT auto-activate plan on session start. Plan is only activated
	// when explicitly set via /planner-create or /planner-resume.
	// These commands call activatePlannerToolVisibility(pi).

	// On session start: apply current planActiveCache state to hide/show tools.
	// On fresh start planActiveCache = false → tools hidden.
	// After /planner-create /planner-resume planActiveCache = true → tools shown.
	pi.on("session_start", async (_event, ctx) => {
		restorePlannerToolVisibilityFromSession(ctx);
		updateToolVisibility(pi);
	});

	// Refresh tool visibility on every provider request.
	pi.on("before_provider_request", async () => {
		updateToolVisibility(pi);
	});
}
