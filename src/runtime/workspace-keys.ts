/**
 * Workspace keybindings, split into the two kinds the user can edit:
 *
 * 1. The workspace's own actions (focusNext, scroll, …), overridable via the
 *    `workspace.keys` planner setting. We own their defaults.
 * 2. Pi-inherited actions (submit, newline, dequeue, thinking/tools toggles),
 *    overridable in `~/.pi/agent/keybindings.json`. Pi owns their defaults; we
 *    mirror the defaults here only to display them, and read the user's live
 *    overrides so the helper shows the keys that are actually in effect.
 *
 * This module has no TUI dependencies so both the dashboard (runtime) and the
 * /planner-helper report can resolve key hints from it.
 */

export type WorkspaceAction =
	| "focusNext"
	| "up"
	| "down"
	| "pageUp"
	| "pageDown"
	| "jumpBottom"
	| "jumpTop"
	| "expand"
	| "submit"
	| "exit";

/** Built-in workspace keys; overridable via settings workspace.keys. */
export const DEFAULT_WORKSPACE_KEYS: Record<WorkspaceAction, string[]> = {
	focusNext: ["tab"],
	up: ["up"],
	down: ["down"],
	pageUp: ["pageUp"],
	pageDown: ["pageDown"],
	jumpBottom: ["end"],
	jumpTop: ["home"],
	expand: ["x"],
	submit: ["enter"],
	exit: ["escape"],
};

export function resolveWorkspaceKeys(
	overrides: Partial<Record<WorkspaceAction, string[]>> | undefined,
): Record<WorkspaceAction, string[]> {
	const resolved = { ...DEFAULT_WORKSPACE_KEYS };
	if (overrides) {
		for (const action of Object.keys(
			DEFAULT_WORKSPACE_KEYS,
		) as WorkspaceAction[]) {
			const keys = overrides[action];
			if (keys && keys.length > 0) resolved[action] = keys;
		}
	}
	return resolved;
}

/** Pi action ids the workspace inherits, with Pi's own default keys (for display). */
export const WORKSPACE_PI_KEY_DEFAULTS = {
	"tui.input.submit": "enter",
	"tui.input.newLine": "shift+enter",
	"app.message.dequeue": "alt+up",
	"app.thinking.toggle": "ctrl+t",
	"app.tools.expand": "ctrl+o",
} as const;

export type WorkspacePiActionId = keyof typeof WORKSPACE_PI_KEY_DEFAULTS;

/** Raw `keybindings.json` shape: action id → one key or a list (or unset = default). */
export type PiKeybindingOverrides = Record<
	string,
	string | string[] | undefined
>;

function fmtKeys(keys: readonly string[]): string {
	return keys.length > 0 ? keys.join("/") : "(unset)";
}

/** Resolve a Pi-inherited action to its effective key string (override else default). */
export function resolvePiKeyHint(
	id: WorkspacePiActionId,
	overrides: PiKeybindingOverrides | undefined,
): string {
	const override = overrides?.[id];
	if (override === undefined) return WORKSPACE_PI_KEY_DEFAULTS[id];
	return fmtKeys(Array.isArray(override) ? override : [override]);
}

export interface WorkspaceKeyHints {
	send: string;
	newline: string;
	dequeue: string;
	thinkingToggle: string;
	toolsExpand: string;
	focusNext: string;
	scroll: string;
	pageScroll: string;
	jumpBottom: string;
	jumpTop: string;
	expand: string;
	exit: string;
}

/**
 * Resolve the effective key strings shown in /planner-helper, combining the
 * user's Pi overrides with the workspace's own (possibly overridden) keys.
 */
export function buildWorkspaceKeyHints(input: {
	workspaceKeys: Record<WorkspaceAction, string[]>;
	piOverrides: PiKeybindingOverrides | undefined;
}): WorkspaceKeyHints {
	const { workspaceKeys, piOverrides } = input;
	return {
		send: resolvePiKeyHint("tui.input.submit", piOverrides),
		newline: resolvePiKeyHint("tui.input.newLine", piOverrides),
		dequeue: resolvePiKeyHint("app.message.dequeue", piOverrides),
		thinkingToggle: resolvePiKeyHint("app.thinking.toggle", piOverrides),
		toolsExpand: resolvePiKeyHint("app.tools.expand", piOverrides),
		focusNext: fmtKeys(workspaceKeys.focusNext),
		scroll: `${fmtKeys(workspaceKeys.up)}/${fmtKeys(workspaceKeys.down)}`,
		pageScroll: `${fmtKeys(workspaceKeys.pageUp)}/${fmtKeys(workspaceKeys.pageDown)}`,
		jumpBottom: fmtKeys(workspaceKeys.jumpBottom),
		jumpTop: fmtKeys(workspaceKeys.jumpTop),
		expand: fmtKeys(workspaceKeys.expand),
		exit: fmtKeys(workspaceKeys.exit),
	};
}
