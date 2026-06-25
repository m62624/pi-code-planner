import type { EffectivePlannerSettings } from "../settings/manager";
import { DEFAULT_PLANNER_SETTINGS } from "../settings/schema";
import type { ProjectStoragePaths } from "../storage/paths";
import {
	PLANNER_READONLY_CONTEXT_BASENAMES,
	PLANNER_WRITABLE_CONTRACT_BASENAMES,
} from "./contracts";
import type { WorkspaceKeyHints } from "./workspace-keys";

interface SettingDescriptor {
	path: string;
	purpose: string;
}

const SETTING_DESCRIPTORS: SettingDescriptor[] = [
	{
		path: "worktree.mode",
		purpose: "Where planner worktrees are created.",
	},
	{
		path: "worktree.root",
		purpose:
			"Absolute root for custom worktrees; used only when worktree.mode is custom.",
	},
	{
		path: "compact.stage",
		purpose: "Request planner-controlled compaction at stage boundaries.",
	},
	{
		path: "compact.task",
		purpose: "Request planner-controlled compaction at task boundaries.",
	},
	{
		path: "idle.enabled",
		purpose:
			"Enable the idle watchdog that wakes a running planner step after inactivity.",
	},
	{
		path: "idle.timeoutMinutes",
		purpose: "Minutes since last planner/tool activity before idle wake-up.",
	},
	{
		path: "exec.defaultTimeoutSeconds",
		purpose:
			"Timeout for planner_exec when the model passes no timeoutSeconds.",
	},
	{
		path: "exec.maxTimeoutSeconds",
		purpose:
			"Hard ceiling for planner_exec timeoutSeconds the model can request.",
	},
	{
		path: "exec.maxOutputBytes",
		purpose:
			"Maximum stdout+stderr bytes kept from planner_exec; extra output is truncated.",
	},
	{
		path: "timer.enabled",
		purpose: "Show or hide passive planner runtime telemetry.",
	},
	{
		path: "timer.mode",
		purpose:
			"status shows one footer line; widget shows a passive block above the editor.",
	},
	{
		path: "timer.showCheckpoints",
		purpose: "Show recent stage checkpoint timings in timer telemetry.",
	},
	{
		path: "timer.maxCheckpoints",
		purpose: "Maximum timer checkpoint entries shown.",
	},
	{
		path: "timer.syncIntervalMinutes",
		purpose: "How often timer heartbeat state is written to disk.",
	},
	{
		path: "skills.enabled",
		purpose:
			"Expose planner-generated skills to active planner sessions through Pi resources_discover.",
	},
	{
		path: "skills.maxActive",
		purpose:
			"Maximum planner skills exposed to Pi; 0 means no planner-side limit.",
	},
	{
		path: "contracts.enabled",
		purpose:
			"Enable planner local AGENTS.md contract discovery, routing, checks, and upserts.",
	},
	{
		path: "contracts.finalPolicy",
		purpose:
			"What /planner-finish does with planner-created or updated AGENTS.md files.",
	},
	{
		path: "contracts.scanBatchSize",
		purpose: "Directory count scanned per planner_contract_scan call.",
	},
	{
		path: "contracts.statusCharBudget",
		purpose: "Maximum saved contract-summary text shown in planner_status.",
	},
	{
		path: "contracts.readChunkChars",
		purpose:
			"Chunk size for planner_contract_read; full bodies are not injected by planner_status.",
	},
	{
		path: "contracts.maxActiveChains",
		purpose: "Maximum active contract chains kept in state.json.",
	},
	{
		path: "contracts.levelBudgets.root",
		purpose: "Summary budget for root-level routing contracts.",
	},
	{
		path: "contracts.levelBudgets.ancestor",
		purpose: "Summary budget for intermediate domain contracts.",
	},
	{
		path: "contracts.levelBudgets.nearest",
		purpose: "Summary budget for the nearest applicable domain contract.",
	},
	{
		path: "workspace.enabled",
		purpose:
			"Master switch for the /planner-dashboard workspace window (dashboard + model chat).",
	},
	{
		path: "workspace.autoOpen",
		purpose:
			"Open the workspace automatically for planner-worktree sessions (create/resume/improve).",
	},
	{
		path: "workspace.footerReserveRows",
		purpose:
			"Terminal rows left for Pi's native footer below the workspace overlay (raise if the footer overlaps).",
	},
	{
		path: "workspace.keys",
		purpose:
			"Optional per-action keybinding overrides for the workspace TUI; unset means built-in keys (see SETTINGS.md).",
	},
	{
		path: "diagnostics.enabled",
		purpose:
			"Enable stuck detection and the sanitized planner_recovery_report tool.",
	},
	{
		path: "diagnostics.blockedTransitions",
		purpose: "Blocked planner transitions in a row that count as stuck.",
	},
	{
		path: "diagnostics.stuckMinutes",
		purpose:
			"Minutes since the first blocked transition that count as stuck, even without a long streak.",
	},
	{
		path: "metadata.humanLanguage",
		purpose: "Default language for user-facing planner text.",
	},
	{
		path: "metadata.titleLanguage",
		purpose: "Plan title language proposed through planner_goal_submit.",
	},
	{
		path: "metadata.descriptionLanguage",
		purpose: "Short /planner-resume list description language.",
	},
	{
		path: "metadata.commitLanguage",
		purpose:
			"Human-readable parts of the commit/merge messages the model writes; the auto-assembled export commit is not re-translated.",
	},
	{
		path: "metadata.doubtReviewLanguage",
		purpose: "Human-readable content inside finalize/doubt_review.",
	},
	{
		path: "metadata.skillLanguage",
		purpose: "Human-readable body text for planner-generated Pi skills.",
	},
];

export function buildPlannerAboutReport(input: {
	settings: EffectivePlannerSettings;
	projectPaths: ProjectStoragePaths;
	audience: "human" | "agent";
	/** Effective workspace key bindings, resolved from Pi + planner settings. */
	keyHints: WorkspaceKeyHints;
}): string {
	const k = input.keyHints;
	const heading =
		input.audience === "human" ? "Planner Helper" : "Planner About";
	return [
		`# ${heading}`,
		"",
		"pi-code-planner is a Pi extension that wraps long coding work in persisted planner stages, isolated Git worktrees, controlled planner tools, local contract memory, and explicit user acceptance.",
		"",
		"## Current Project",
		`- projectRoot: ${input.projectPaths.projectRoot}`,
		`- projectId: ${input.projectPaths.projectId}`,
		`- global settings: ${input.settings.paths.globalSettingsJson}`,
		`- project settings: ${input.settings.paths.projectSettingsJson}`,
		"",
		"## Runtime Model",
		"- The chat is not the source of truth; planner JSON and Markdown artifacts are.",
		"- Call planner_status before choosing planner actions.",
		"- /planner-create, /planner-improve, and /planner-resume explicitly activate planner tools and planner-generated skills.",
		"- /planner-improve starts a discovery-first self-improvement plan; the model writes goal.md from discovery findings.",
		"- /planner-finish is the explicit accepted-result export and cleanup command.",
		"- /planner-skills is a read/search/delete inventory command for saved planner-generated skills.",
		"",
		"## Local Contract Memory",
		`- Writable canonical files: ${PLANNER_WRITABLE_CONTRACT_BASENAMES.join(", ")}.`,
		`- Read-only imported context files: ${PLANNER_READONLY_CONTEXT_BASENAMES.join(", ")}.`,
		"- Durable planner routing memory belongs in AGENTS.md managed blocks.",
		"- Imported context files are read as guidance and are not edited by planner_contract_upsert.",
		"",
		"## Planner Skill Memory",
		"- Planner-generated skills are stored under getAgentDir()/extensions/pi-code-planner/skills/.",
		"- Runtime exposure respects skills.enabled and skills.maxActive.",
		"- /planner-skills shows the saved inventory even when runtime exposure is disabled or capped.",
		"- Missing SKILL.md files are ignored by inventory/resource discovery; delete stale index entries through /planner-skills when needed.",
		"",
		"## Logical Consistency (elenchus)",
		"- elenchus is a mechanical logical-consistency checker: you state facts and first principles in a tiny English-like DSL and a three-valued SAT engine answers CONSISTENT/WARNING/UNDERDETERMINED/CONFLICT, pointing at the premises to blame. It catches contradictions and gaps a hand-derived argument misses. Project home: https://github.com/m62624/elenchus",
		"- This extension ships its OWN WebAssembly build of the engine (the elenchus-wasm npm package) bundled inside it. planner_elenchus_check always calls that in-process wasm engine — never a host-installed `elenchus` CLI or an elenchus MCP server. This is deliberate: it avoids version conflicts and keeps the engine locked to the DSL version the planner was built against, so nothing you install globally changes planner behavior.",
		"- The matching DSL skill ships bundled too and is served (version-locked) as pi-planner-elenchus, taking priority over any host-installed elenchus skill.",
		"- planner_elenchus_check is a soft gate at planning/consistency_check and is also available at the discovery scan, finalize/doubt_review, and recovery/repair_or_resume. It fits a web of interacting constraints (exactly-one-owner, mutually-exclusive states, gate/branch coverage, access matrices, dependency ordering); resolution=not_applicable with a reason is the terminal escape so the flow never deadlocks.",
		"- Sources (<name>.vrf) and verdicts (<name>.result.json) are stored under getAgentDir()/extensions/pi-code-planner/plans/<planId>/elenchus/.",
		"- To use elenchus outside this extension or in another harness, install the matching binary or read more at https://github.com/m62624/elenchus — that standalone install is independent of the wasm engine bundled here.",
		"",
		"## Planner Workspace TUI",
		"- /planner-dashboard opens the workspace: stage dashboard + the model chat in one window. It also opens automatically for planner-worktree sessions (workspace.autoOpen).",
		`- The composer is always live at the bottom: type anywhere. ${k.send} sends; ${k.newline} inserts a newline for multiline messages.`,
		`- ${k.focusNext} toggles which pane the navigation keys drive:`,
		`  - chat: ${k.scroll} / ${k.pageScroll} scroll; ${k.jumpBottom} jumps to the live tail, ${k.jumpTop} to the top; ${k.expand} toggles expand-all for tool calls.`,
		"  - tasks: scroll keys select a task and reveal the task list + stage timings; ←→ nudge the ticker.",
		`- Typing while the agent is busy queues the message (shown dimmed above the composer) and sends it as a follow-up when the agent goes idle; ${k.dequeue} pulls the last queued message back to edit it.`,
		"- Send/newline/dequeue follow Pi's own bindings (tui.input.submit, tui.input.newLine, app.message.dequeue); the keys above reflect your current overrides.",
		`- Inherits Pi bindings: app.thinking.toggle (${k.thinkingToggle}) hides/shows thinking; app.tools.expand (${k.toolsExpand}) expands/collapses tool output.`,
		`- ${k.exit} (or Ctrl+C) closes the workspace and returns to the plain chat.`,
		"- Streaming assistant output is shown live, token by token, as it is generated.",
		"- Pi's own keys (cursor movement, model/thinking selectors, etc.) are configured in ~/.pi/agent/keybindings.json; run /reload after editing. See SETTINGS.md and the Pi keybindings docs.",
		"- If Pi's native footer overlaps or leaves a gap below the workspace, tune workspace.footerReserveRows.",
		"",
		"## Effective Settings",
		"Settings merge order: defaults, global settings, then project settings.",
		"",
		"| Setting | Current | Default | Source | Purpose |",
		"| --- | --- | --- | --- | --- |",
		...SETTING_DESCRIPTORS.map((descriptor) =>
			formatSettingRow(descriptor, input.settings),
		),
		"",
		...(input.settings.warnings.length > 0
			? [
					"",
					"## Settings Warnings",
					"Unrecognized or deprecated keys found in your settings.json. They are ignored (parsing never fails); remove them to silence this.",
					...input.settings.warnings.map((warning) => `- ${warning}`),
				]
			: []),
		"",
		"## Notes",
		"- worktree and compact settings are captured when a plan is created.",
		"- idle, timer, metadata, skills, contracts, and workspace settings are read while planner runs.",
		"- skills.maxActive = 0 means no planner-side limit.",
	].join("\n");
}

function formatSettingRow(
	descriptor: SettingDescriptor,
	settings: EffectivePlannerSettings,
): string {
	return [
		`| \`${descriptor.path}\``,
		formatValue(getPath(settings.effective, descriptor.path)),
		formatValue(getPath(DEFAULT_PLANNER_SETTINGS, descriptor.path)),
		settingSource(settings, descriptor.path),
		escapeTableText(descriptor.purpose),
	]
		.join(" | ")
		.concat(" |");
}

function settingSource(
	settings: EffectivePlannerSettings,
	path: string,
): string {
	const group = path.split(".")[0];
	switch (group) {
		case "worktree":
			return settings.worktreeSource;
		case "compact":
			return settings.compactSource;
		case "idle":
			return settings.idleSource;
		case "exec":
			return settings.execSource;
		case "diagnostics":
			return settings.diagnosticsSource;
		case "metadata":
			return settings.metadataSource;
		case "timer":
			return settings.timerSource;
		case "skills":
			return settings.skillsSource;
		case "contracts":
			return settings.contractsSource;
		case "workspace":
			return settings.workspaceSource;
		default:
			return "default";
	}
}

function getPath(value: unknown, path: string): unknown {
	return path.split(".").reduce<unknown>((current, key) => {
		if (!current || typeof current !== "object") return undefined;
		return (current as Record<string, unknown>)[key];
	}, value);
}

function formatValue(value: unknown): string {
	if (value === undefined) return "`unset`";
	return `\`${escapeTableText(JSON.stringify(value))}\``;
}

function escapeTableText(value: string): string {
	// Escape the backslash first, otherwise an input backslash before a pipe
	// would consume the pipe's escape and break the markdown table cell.
	return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");
}
