import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { ALL_PLANNER_TOOL_NAMES } from "./guard/tool-policy";
import type { PlannerFs } from "./storage/fs";

export interface RegisteredTool {
	name: string;
}

const plannerNames: Set<string> = new Set(ALL_PLANNER_TOOL_NAMES);
const PLANNER_TOOL_VISIBILITY_CUSTOM_TYPE = "planner-tool-visibility";

interface PlannerToolVisibilityState {
	active: boolean;
}

/** Cached plan active state — false by default, updated after planner commands. */
let planActiveCache: boolean = false;

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

/** Update the list of active tools in the Pi extension API. */
export function updateToolVisibility(pi: ExtensionAPI): void {
	const allTools = pi.getAllTools();
	const toolNames = planActiveCache
		? allTools.map((t) => t.name)
		: filterPlannerTools(allTools).map((t) => t.name);

	pi.setActiveTools(toolNames);
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
