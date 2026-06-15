import type { EffectivePlannerSettings } from "../settings/manager";
import { DEFAULT_PLANNER_SETTINGS } from "../settings/schema";
import type { ProjectStoragePaths } from "../storage/paths";
import {
	PLANNER_READONLY_CONTEXT_BASENAMES,
	PLANNER_WRITABLE_CONTRACT_BASENAMES,
} from "./contracts";

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
		path: "contracts.requireAfterTdd",
		purpose: "Require execution/contract_check after a green implementation.",
	},
	{
		path: "contracts.requireBeforeEditOutsideChain",
		purpose:
			"Instruct the model to route/read contracts before leaving declared task scope.",
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
		purpose: "Human-readable parts of planner commit messages.",
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
}): string {
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
		"## Planner Workspace TUI",
		"- /planner-dashboard opens the workspace: stage dashboard + the model chat in one window. It also opens automatically for planner-worktree sessions (workspace.autoOpen).",
		"- Inside the workspace, Tab cycles three focus panes:",
		"  - input: type and press Enter to send a message to the model.",
		"  - chat: ↑↓ / PageUp / PageDown scroll the transcript; x toggles expand-all for collapsed tool calls.",
		"  - tasks: ↑↓ select a task and reveal the task list + stage timings; ←→ nudge the ticker.",
		"- Esc (or Ctrl+C) closes the workspace and returns to the plain chat.",
		"- Streaming assistant output is shown live as it is generated.",
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
		case "metadata":
			return settings.metadataSource;
		case "timer":
			return settings.timerSource;
		case "skills":
			return settings.skillsSource;
		case "contracts":
			return settings.contractsSource;
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
	return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
