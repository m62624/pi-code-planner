import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type KeybindingsManager,
	type SessionEntry,
	type Theme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Editor,
	type EditorTheme,
	type KeyId,
	matchesKey,
	type OverlayHandle,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { MS_PER_MINUTE } from "../constants";
import { loadEffectivePlannerSettings } from "../settings/manager";
import { createNodeFs, type PlannerFs } from "../storage/fs";
import type { ProjectStoragePaths } from "../storage/paths";
import { resolveProjectStoragePaths } from "../storage/project-resolver";
import type { PlannerStage } from "../storage/schema";
import { readActivePlanContext } from "./active-plan";
import {
	type ChatRow,
	projectLiveAssistant,
	projectSessionEntries,
	renderTranscript,
} from "./chat-view";
import {
	applyLiveTiming,
	buildPlannerDashboardModel,
	type DashboardPalette,
	type DashboardUiState,
	dashboardDivider,
	formatClock,
	frameWorkspace,
	liveTotalMs,
	type PlannerDashboardModel,
	renderDashboardBand,
	renderDashboardColumns,
} from "./dashboard-model";
import { resolveWorkspaceKeys, type WorkspaceAction } from "./workspace-keys";

const TICK_MS = 180;
/**
 * Reload structural model state (tasks, stage) from disk every Nth tick (~3s).
 * The clock and stage timings tick live in-memory between reloads, so we do not
 * hit disk every second.
 */
const RELOAD_EVERY_TICKS = 16;
/** Rows left for Pi's native footer below the workspace overlay. */
const DEFAULT_FOOTER_RESERVE = 3;
/**
 * How many trailing session entries to project at a time. The transcript shows
 * a sliding window over the conversation; scrolling to the top loads another
 * chunk so very long sessions never project everything at once.
 */
const HISTORY_WINDOW = 400;
/** Minimum gap between streaming-driven redraws (~12 fps). */
const STREAM_THROTTLE_MS = 80;

const STAGE_THEME_COLOR: Record<PlannerStage, ThemeColor> = {
	init: "syntaxComment",
	intake: "syntaxKeyword",
	discovery: "syntaxFunction",
	planning: "syntaxType",
	execution: "syntaxString",
	finalize: "syntaxNumber",
	done: "success",
	recovery: "error",
};

/**
 * Latest in-flight assistant message while the model is streaming. Updated by
 * message_update events and cleared at message_end, so the workspace can show
 * token-by-token output before the entry is committed to the session.
 */
let liveAssistantMessage: unknown | null = null;
/** Notifies the open workspace (if any) to redraw on each streaming token. */
let liveStreamListener: (() => void) | null = null;
/**
 * Whether the agent is mid-run (between agent_start and agent_end). The
 * workspace queues messages typed while busy and flushes them when it clears,
 * instead of dropping them or interrupting the current turn.
 */
let agentBusy = false;
/** Notifies the open workspace that the agent went idle, so it can flush its queue. */
let agentIdleListener: (() => void) | null = null;

export function registerPlannerDashboard(pi: ExtensionAPI): void {
	pi.registerCommand("planner-dashboard", {
		description:
			"Open the planner workspace: live stage dashboard, task list, and the model chat in one window.",
		handler: async (_args, ctx) => {
			await openPlannerWorkspace(pi, ctx);
		},
	});

	// Track streaming assistant output and redraw the workspace per token so the
	// chat fills in smoothly, matching Pi's own streaming feel.
	pi.on("message_update", (event) => {
		liveAssistantMessage = (event as { message?: unknown }).message ?? null;
		liveStreamListener?.();
	});
	pi.on("message_end", () => {
		liveAssistantMessage = null;
		liveStreamListener?.();
	});

	// Track whether the agent is running so the workspace can queue messages
	// typed mid-turn and flush them when the agent goes idle. agent_start/end
	// bracket the whole run; message_update covers the streaming window so a
	// message typed during the first token is still treated as "busy".
	const markBusy = () => {
		agentBusy = true;
	};
	const markIdle = () => {
		agentBusy = false;
		agentIdleListener?.();
	};
	pi.on("agent_start", markBusy);
	pi.on("turn_start", markBusy);
	pi.on("message_update", markBusy);
	pi.on("agent_end", markIdle);
}

export async function openPlannerWorkspace(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	options: { auto?: boolean } = {},
): Promise<void> {
	if (!ctx.hasUI) {
		if (!options.auto) {
			ctx.ui.notify(
				"The planner workspace requires interactive mode.",
				"error",
			);
		}
		return;
	}
	const fs = createNodeFs();
	const config = await loadWorkspaceSettings(fs, ctx.cwd);
	if (!config.enabled) {
		if (!options.auto) {
			ctx.ui.notify(
				"The planner workspace is disabled (settings: workspace.enabled).",
				"info",
			);
		}
		return;
	}
	if (options.auto && !config.autoOpen) return;
	const footerReserve = Math.max(0, config.footerReserveRows);
	const load = () => loadDashboardModel(fs, ctx.cwd, config.syncMs);
	const getEntries = () => ctx.sessionManager.getBranch();
	const initial = await load();
	let component: PlannerWorkspaceComponent | null = null;
	await ctx.ui.custom<void>(
		(tui, theme, keybindings, done) => {
			component = new PlannerWorkspaceComponent({
				tui,
				theme,
				keybindings,
				keys: config.keys,
				initial,
				footerReserve,
				load,
				getEntries,
				messaging: {
					isAgentBusy: () => agentBusy,
					// Idle: send normally (triggers the turn immediately).
					send: (text) => pi.sendUserMessage(text),
					// Flushing a queued message: deliverAs:"followUp" so it waits for
					// the current turn to finish instead of interrupting it, even if a
					// new turn started in the gap before we flushed.
					sendQueued: (text) =>
						pi.sendUserMessage(text, { deliverAs: "followUp" }),
				},
				onClose: () => done(undefined),
			});
			return component;
		},
		{
			// Render as a fixed top overlay so the workspace does not live in the
			// chat scrollback (mouse-wheel no longer drags it off-screen) and the
			// native footer stays visible in the reserved rows below it.
			//
			// overlayOptions() is evaluated once at show time, so these must be
			// RELATIVE values: the layout is re-resolved against the live terminal
			// every render, but absolute numbers would pin the overlay to the
			// startup size and never grow when the terminal is enlarged. "100%"
			// width/height track the terminal both ways; margin.bottom reserves the
			// footer rows.
			overlay: true,
			overlayOptions: {
				width: "100%",
				maxHeight: "100%",
				anchor: "top-left",
				row: 0,
				col: 0,
				margin: { bottom: footerReserve },
			},
			// When another extension opens its own overlay (e.g. an ask_user
			// dialog), it captures focus and stacks above us. We use the handle to
			// pause our timer-driven repaints while unfocused so we stop clobbering
			// the foreign overlay's frame, and resume when focus returns.
			onHandle: (handle) => component?.attachHandle(handle),
		},
	);
}

async function loadWorkspaceSettings(
	fs: PlannerFs,
	cwd: string,
): Promise<{
	enabled: boolean;
	autoOpen: boolean;
	footerReserveRows: number;
	syncMs: number;
	keys: Record<WorkspaceAction, string[]>;
}> {
	try {
		const projectPaths = await resolveProjectStoragePaths({
			fs,
			agentDir: getAgentDir(),
			cwd,
		});
		const settings = await loadEffectivePlannerSettings({ fs, projectPaths });
		const workspace = settings.effective.workspace;
		return {
			enabled: workspace.enabled,
			autoOpen: workspace.autoOpen,
			footerReserveRows: workspace.footerReserveRows,
			syncMs: settings.effective.timer.syncIntervalMinutes * MS_PER_MINUTE,
			keys: resolveWorkspaceKeys(workspace.keys),
		};
	} catch {
		return {
			enabled: true,
			autoOpen: true,
			footerReserveRows: DEFAULT_FOOTER_RESERVE,
			syncMs: 600_000,
			keys: resolveWorkspaceKeys(undefined),
		};
	}
}

async function loadDashboardModel(
	fs: PlannerFs,
	cwd: string,
	syncMs: number,
): Promise<PlannerDashboardModel> {
	try {
		const projectPaths: ProjectStoragePaths = await resolveProjectStoragePaths({
			fs,
			agentDir: getAgentDir(),
			cwd,
		});
		const context = await readActivePlanContext({ fs, projectPaths });
		return buildPlannerDashboardModel({ context, now: Date.now(), syncMs });
	} catch (error) {
		return {
			available: false,
			reason: `Failed to read planner state: ${
				error instanceof Error ? error.message : String(error)
			}`,
			hint: "Check that a planner plan exists for this directory.",
		};
	}
}

// The editor (Pi's native Editor) is always the input — type from anywhere.
// There is no separate "chat" pane: the transcript scrolls with PageUp/PageDown
// and never takes focus. Tab only toggles a "tasks" view for selecting a task.
type WorkspaceFocus = "editor" | "tasks";

interface WorkspaceMessaging {
	isAgentBusy: () => boolean;
	send: (text: string) => void;
	sendQueued: (text: string) => void;
}

export class PlannerWorkspaceComponent implements Component {
	private readonly tui: TUI;
	private readonly palette: DashboardPalette;
	private readonly load: () => Promise<PlannerDashboardModel>;
	private readonly getEntries: () => SessionEntry[];
	private readonly messaging: WorkspaceMessaging;
	private readonly onClose: () => void;
	private readonly footerReserve: number;
	private readonly keybindings: KeybindingsManager;
	private readonly keys: Record<WorkspaceAction, string[]>;

	private model: PlannerDashboardModel;
	private rows: ChatRow[] = [];
	/** Pi's native editor, used as the composer (paste markers, history, etc.). */
	private readonly editor: Editor;
	/** Messages typed while the agent was busy, shown dimmed above the composer. */
	private queued: string[] = [];
	private focus: WorkspaceFocus = "editor";
	/** Follow the live tail (true) or hold an absolute scroll position. */
	private atBottom = true;
	private topLine = 0;
	private expandAll = false;
	private hideThinking = false;
	// Sliding-window projection state.
	private windowEntries = HISTORY_WINDOW;
	private hasMoreHistory = false;
	private cachedEntryKey = "";
	private cachedBaseRows: ChatRow[] = [];
	private readonly ui: DashboardUiState = {
		selectedIndex: 0,
		taskScroll: 0,
		focus: "tasks",
	};

	private interval: ReturnType<typeof setInterval> | null = null;
	private tick = 0;
	private reloading = false;
	private version = 0;
	private lastSignature = "";
	private lastStreamRenderAt = 0;
	private streamFlushTimer: ReturnType<typeof setTimeout> | null = null;
	private lastTranscriptTotal = 0;
	private lastTranscriptHeight = 1;
	private cachedWidth = -1;
	private cachedHeight = -1;
	private cachedVersion = -1;
	private cachedLines: string[] = [];
	// The transcript is the expensive part of a draw. The live clock and stage
	// timings change the overall signature every second, but they never change
	// the transcript — so cache it by a content key and reuse it across those
	// clock-only redraws instead of re-laying-out every row.
	private cachedTranscriptKey = "";
	private cachedTranscript: ReturnType<typeof renderTranscript> | null = null;
	// Overlay handle (set once shown). While another overlay is focused above us
	// we pause repaints so we don't clobber its frame; we resume on refocus.
	private handle: OverlayHandle | null = null;
	private wasFocused = true;

	constructor(input: {
		tui: TUI;
		theme: Theme;
		keybindings: KeybindingsManager;
		keys: Record<WorkspaceAction, string[]>;
		initial: PlannerDashboardModel;
		footerReserve: number;
		load: () => Promise<PlannerDashboardModel>;
		getEntries: () => SessionEntry[];
		messaging: WorkspaceMessaging;
		onClose: () => void;
	}) {
		this.tui = input.tui;
		this.palette = buildPalette(input.theme);
		this.keybindings = input.keybindings;
		this.keys = input.keys;
		this.footerReserve = input.footerReserve;
		this.load = input.load;
		this.getEntries = input.getEntries;
		this.messaging = input.messaging;
		this.onClose = input.onClose;
		this.model = input.initial;
		// Pi's native editor as the composer: paste markers, multiline, history,
		// kill-ring, undo, word-nav — all on Pi's configurable keybindings. We just
		// wrap it with the queue + pane navigation.
		this.editor = new Editor(input.tui, buildEditorTheme(this.palette));
		// Always live so you can type from any pane (Tab only re-targets the
		// navigation keys); the cursor is always shown.
		this.editor.focused = true;
		this.editor.onSubmit = (text) => this.onEditorSubmit(text);
		// Repaint on every edit (typing, paste collapse, history nav).
		this.editor.onChange = () => this.bump();
		this.refreshRows();
		this.interval = setInterval(() => this.onTick(), TICK_MS);
		this.interval.unref?.();
		// Redraw on streaming tokens, throttled so a fast token stream cannot
		// drive an unbounded repaint rate.
		liveStreamListener = () => this.onStreamUpdate();
		// Flush queued messages once the agent goes idle.
		agentIdleListener = () => this.flushQueue();
	}

	attachHandle(handle: OverlayHandle): void {
		this.handle = handle;
	}

	/** True unless a foreign overlay is focused above us (or before we have a handle). */
	private isOverlayFocused(): boolean {
		return this.handle ? this.handle.isFocused() : true;
	}

	private onTick(): void {
		const focused = this.isOverlayFocused();
		// Yield the top layer to a focused foreign overlay (e.g. another
		// extension's ask_user dialog): hide ourselves so we don't draw over it,
		// but KEEP requesting renders so the TUI keeps compositing and the foreign
		// overlay's own timers/animations stay live. (Stopping repaints entirely
		// froze those overlays until the user typed.)
		if (!focused) {
			this.handle?.setHidden(true);
			this.tui.requestRender();
			this.wasFocused = false;
			return;
		}
		// Focus returned (foreign overlay closed): unhide and force one repaint so
		// our content refreshes immediately.
		if (!this.wasFocused) {
			this.handle?.setHidden(false);
			this.tui.requestRender();
		}
		this.wasFocused = true;

		this.refreshRows();
		if (this.tick % RELOAD_EVERY_TICKS === 0) void this.reloadModel();
		this.tick += 1;
		// Redraw only when something visible actually changed (clock second,
		// content, or focus/input). When nothing changed this is a cheap no-op,
		// so the workspace is not CPU-bound while idle.
		this.renderIfChanged();
	}

	private onStreamUpdate(): void {
		const now = Date.now();
		const elapsed = now - this.lastStreamRenderAt;
		if (elapsed >= STREAM_THROTTLE_MS) {
			this.lastStreamRenderAt = now;
			this.refreshRows();
			this.renderIfChanged();
			return;
		}
		if (!this.streamFlushTimer) {
			this.streamFlushTimer = setTimeout(() => {
				this.streamFlushTimer = null;
				this.lastStreamRenderAt = Date.now();
				this.refreshRows();
				this.renderIfChanged();
			}, STREAM_THROTTLE_MS - elapsed);
			this.streamFlushTimer.unref?.();
		}
	}

	private refreshRows(): void {
		try {
			const entries = this.getEntries();
			const total = entries.length;
			const start = Math.max(0, total - this.windowEntries);
			this.hasMoreHistory = start > 0;
			const lastId = total > 0 ? (entries[total - 1].id ?? "") : "";
			// Reproject only when the windowed slice actually changed, so we do not
			// rebuild the whole transcript on every 180ms tick.
			const key = `${total}:${start}:${lastId}`;
			if (key !== this.cachedEntryKey) {
				this.cachedBaseRows = projectSessionEntries(entries.slice(start));
				this.cachedEntryKey = key;
			}
			this.rows = liveAssistantMessage
				? [
						...this.cachedBaseRows,
						...projectLiveAssistant(liveAssistantMessage),
					]
				: this.cachedBaseRows;
		} catch {
			// Keep last rows on transient read failure.
		}
	}

	/** Load the next older chunk of history when scrolled to the top. */
	private growHistory(): void {
		if (!this.hasMoreHistory) return;
		this.windowEntries += HISTORY_WINDOW;
		this.cachedEntryKey = "";
		this.refreshRows();
	}

	private async reloadModel(): Promise<void> {
		if (this.reloading) return;
		this.reloading = true;
		try {
			this.model = await this.load();
			this.clampSelection();
			this.renderIfChanged();
		} catch {
			// Best-effort.
		} finally {
			this.reloading = false;
		}
	}

	private renderIfChanged(): void {
		const signature = this.computeSignature();
		if (signature === this.lastSignature) return;
		this.scheduleRender(signature);
	}

	private computeSignature(): string {
		const last = this.rows[this.rows.length - 1];
		const rowsSig = `${this.rows.length}:${last?.key ?? ""}:${last?.text.length ?? 0}`;
		const clock = this.model.available
			? formatClock(liveTotalMs(this.model, Date.now()))
			: "x";
		const modelSig = this.model.available
			? `${this.model.stage}/${this.model.step}/${this.model.stepStatus}/${this.model.tasksDone}/${this.model.tasksTotal}`
			: "unavailable";
		// queued length + total chars is enough to detect any queue change without
		// hashing every message; agentBusy flips the composer hint.
		const queueSig = `${this.queued.length}:${this.queued.reduce((n, m) => n + m.length, 0)}:${this.messaging.isAgentBusy() ? "busy" : "idle"}`;
		// The editor's own text/cursor are not in the signature — editor edits call
		// onChange -> bump() directly, which advances the version and repaints.
		const uiSig = `${this.focus}|${this.ui.selectedIndex}|${this.atBottom}:${this.topLine}|${this.expandAll}|${this.hideThinking}|${queueSig}`;
		// Terminal size is part of the signature so a resize triggers a redraw.
		// Without it the idle tick keeps the same signature after a resize and
		// never calls requestRender(), leaving the overlay frozen at the old size.
		const termSig = `${process.stdout.columns ?? 0}x${process.stdout.rows ?? 0}`;
		return `${clock}#${rowsSig}#${modelSig}#${uiSig}#${termSig}`;
	}

	private scheduleRender(signature = this.computeSignature()): void {
		this.lastSignature = signature;
		this.version += 1;
		// Always request the render: when a foreign overlay is up we are hidden
		// (see onTick), so this composites the foreign overlay without drawing our
		// content over it — and keeps that overlay's timers live.
		this.tui.requestRender();
	}

	private clampSelection(): void {
		const total = this.model.available ? this.model.tasks.length : 0;
		if (this.ui.selectedIndex > total - 1) {
			this.ui.selectedIndex = Math.max(0, total - 1);
		}
	}

	private matchesAction(action: WorkspaceAction, data: string): boolean {
		return this.keys[action].some((key) => matchesKey(data, key as KeyId));
	}

	/**
	 * The effective key(s) for a Pi-inherited action, resolved live from the
	 * user's keybindings so composer hints show what is actually bound (e.g.
	 * ctrl+j for newline when the user rebound tui.input.newLine).
	 */
	private keyHint(id: string): string {
		try {
			const keys = this.keybindings.getKeys(id as never);
			return keys.length > 0 ? keys.join("/") : id;
		} catch {
			return id;
		}
	}

	handleInput(data: string): void {
		// A focused foreign overlay receives input directly; ignore anything that
		// still reaches us while we are not the focused overlay.
		if (!this.isOverlayFocused()) return;
		// While the editor's completion popup is open it owns esc/tab to close it.
		const editorBusy =
			this.focus === "editor" && this.editor.isShowingAutocomplete();
		// ctrl+c always exits as a safety net, regardless of key overrides.
		if (matchesKey(data, "ctrl+c")) {
			this.dispose();
			this.onClose();
			return;
		}
		if (!editorBusy && this.matchesAction("exit", data)) {
			this.dispose();
			this.onClose();
			return;
		}
		// Inherit Pi's own keybindings for thinking visibility and tool expansion.
		if (this.keybindings.matches(data, "app.thinking.toggle")) {
			this.hideThinking = !this.hideThinking;
			this.bump();
			return;
		}
		if (this.keybindings.matches(data, "app.tools.expand")) {
			this.expandAll = !this.expandAll;
			this.bump();
			return;
		}
		// Alt+Up restores the last queued message into the editor (app.message.dequeue).
		if (this.keybindings.matches(data, "app.message.dequeue")) {
			this.editLastQueued();
			return;
		}
		// Tab toggles the tasks view, unless the editor's completion popup wants Tab.
		if (!editorBusy && this.matchesAction("focusNext", data)) {
			this.cycleFocus();
			return;
		}
		// Transcript scroll is global (no pane to focus) and uses dedicated keys so
		// the plain arrows stay with the editor: Ctrl+Up/Down nudge one line
		// (precise), PageUp/PageDown jump a page (wider). PageDown/Ctrl+Down past
		// the bottom re-follow the live tail.
		const page = Math.max(1, this.lastTranscriptHeight - 1);
		if (this.matchesAction("scrollUp", data)) {
			this.scrollBy(-1);
			return;
		}
		if (this.matchesAction("scrollDown", data)) {
			this.scrollBy(1);
			return;
		}
		if (this.matchesAction("pageUp", data)) {
			this.scrollBy(-page);
			return;
		}
		if (this.matchesAction("pageDown", data)) {
			this.scrollBy(page);
			return;
		}
		// In the tasks view, ↑/↓ select a task; everything else falls through.
		if (this.focus === "tasks" && this.handleTasksFocus(data)) return;
		// Pi's editor handles typing, cursor, multiline, paste markers, history,
		// kill-ring, undo — all on its own (Pi) keybindings.
		this.editor.handleInput(data);
		// Repaint after every key the editor consumed. Text edits fire onChange
		// (which bumps for us), but pure cursor moves — arrows, ctrl+] jumpForward,
		// word-nav — do NOT. Without this bump our version-cached render() returns
		// the previous frame, so the cursor only catches up on the next clock tick:
		// that delay is the cursor-movement lag. Re-running render() relays out the
		// editor (transcript stays cached), and the TUI's line diff writes nothing
		// when the frame is unchanged, so the extra repaint is cheap.
		this.bump();
	}

	private cycleFocus(): void {
		this.focus = this.focus === "editor" ? "tasks" : "editor";
		this.bump();
	}

	private editLastQueued(): void {
		const last = this.queued.pop();
		if (last === undefined) return;
		// Restore into the editor, merging with any current draft, and re-target
		// the navigation keys to the editor.
		const draft = this.editor.getText();
		this.editor.setText(draft ? `${draft}\n${last}` : last);
		this.focus = "editor";
		this.bump();
	}

	private flushQueue(): void {
		if (this.queued.length === 0) return;
		const pending = this.queued;
		this.queued = [];
		for (const text of pending) {
			this.editor.addToHistory(text);
			this.messaging.sendQueued(text);
		}
		this.bump();
	}

	/** Returns true when the key was a task-navigation key (and thus consumed). */
	private handleTasksFocus(data: string): boolean {
		const total = this.model.available ? this.model.tasks.length : 0;
		if (this.matchesAction("up", data)) {
			this.ui.selectedIndex = Math.max(0, this.ui.selectedIndex - 1);
			this.bump();
		} else if (this.matchesAction("down", data)) {
			this.ui.selectedIndex = Math.min(
				Math.max(0, total - 1),
				this.ui.selectedIndex + 1,
			);
			this.bump();
		} else {
			return false;
		}
		return true;
	}

	/**
	 * Scroll by `delta` lines (negative = toward older). Anchors to an absolute
	 * top line so newly streamed content appended below never moves the view.
	 * Reaching the bottom re-enables tail-following; reaching the top loads more
	 * history.
	 */
	private scrollBy(delta: number): void {
		const maxTop = Math.max(
			0,
			this.lastTranscriptTotal - this.lastTranscriptHeight,
		);
		const currentTop = this.atBottom ? maxTop : Math.min(this.topLine, maxTop);
		const nextTop = currentTop + delta;
		if (nextTop >= maxTop) {
			this.atBottom = true;
		} else {
			this.atBottom = false;
			this.topLine = Math.max(0, nextTop);
			if (this.topLine === 0 && this.hasMoreHistory) this.growHistory();
		}
		this.bump();
	}

	/**
	 * The editor cleared itself and handed us the fully expanded (paste markers
	 * resolved), trimmed text. Send it now if idle, else hold it in our queue —
	 * shown dimmed above the editor, editable via Alt+Up — and flush on idle.
	 */
	private onEditorSubmit(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		this.atBottom = true;
		try {
			if (this.messaging.isAgentBusy()) {
				this.queued.push(trimmed);
			} else {
				this.editor.addToHistory(trimmed);
				this.messaging.send(trimmed);
			}
		} catch {
			// Ignore send failures; the next refresh will reflect agent state.
		}
		this.bump();
	}

	private bump(): void {
		this.scheduleRender();
	}

	render(widthInput: number): string[] {
		// Never emit a line wider than the live terminal. A stale overlay width
		// (e.g. the terminal shrank between layout and draw) would otherwise build
		// a frame wider than the terminal and trip the TUI's hard width check,
		// crashing Pi. Clamp to the real column count as a safety net.
		const width = Math.max(
			1,
			Math.min(widthInput, this.tui.terminal.columns || widthInput),
		);
		const height = Math.max(16, this.tui.terminal.rows - this.footerReserve);
		if (
			width === this.cachedWidth &&
			height === this.cachedHeight &&
			this.version === this.cachedVersion
		) {
			return this.cachedLines;
		}

		// Recompute the clock + stage timings live (no disk read) each draw.
		const model = applyLiveTiming(this.model, Date.now());
		const rows = this.hideThinking
			? this.rows.filter((row) => row.role !== "thinking")
			: this.rows;
		const inner = width - 2;
		const bodyHeight = Math.max(1, height - 2);
		const band = renderDashboardBand(model, inner, this.palette);

		const top: string[] = [...band];
		if (this.focus === "tasks" && model.available) {
			top.push(dashboardDivider(inner, this.palette));
			const colHeight = Math.min(
				12,
				Math.max(4, Math.floor((bodyHeight - band.length) * 0.4)),
			);
			top.push(
				...renderDashboardColumns(
					model,
					inner,
					colHeight,
					this.palette,
					this.ui,
				),
			);
		}
		top.push(dashboardDivider(inner, this.palette));

		// The editor draws its own top border, so it needs no divider above it
		// (that produced a doubled line). When a queue is present we add one
		// divider to separate it from the transcript.
		const queueLines = this.renderQueue(inner);
		const bottom: string[] = [
			...(queueLines.length > 0
				? [dashboardDivider(inner, this.palette), ...queueLines]
				: []),
			...this.editor.render(inner),
			this.renderHelpLine(inner),
		];

		const transcriptHeight = Math.max(
			1,
			bodyHeight - top.length - bottom.length,
		);
		// Reuse the last transcript layout across clock-only redraws: only when a
		// transcript input actually changed do we re-lay-out the rows.
		const lastRow = rows[rows.length - 1];
		const expandedSig = [...this.expandedKeys()].sort().join(",");
		const transcriptKey = [
			inner,
			transcriptHeight,
			this.atBottom ? "bottom" : `top${this.topLine}`,
			rows.length,
			lastRow?.key ?? "",
			lastRow?.text.length ?? 0,
			this.hideThinking ? "hide" : "show",
			expandedSig,
		].join("#");
		let transcript: ReturnType<typeof renderTranscript>;
		if (this.cachedTranscriptKey === transcriptKey && this.cachedTranscript) {
			transcript = this.cachedTranscript;
		} else {
			transcript = renderTranscript(
				rows,
				{
					width: inner,
					height: transcriptHeight,
					atBottom: this.atBottom,
					topLine: this.topLine,
					expanded: this.expandedKeys(),
				},
				this.palette,
			);
			this.cachedTranscriptKey = transcriptKey;
			this.cachedTranscript = transcript;
		}
		this.lastTranscriptTotal = transcript.totalLines;
		this.lastTranscriptHeight = transcriptHeight;
		if (!this.atBottom) this.topLine = transcript.topLine;

		const body = [...top, ...transcript.lines, ...bottom];
		const lines = frameWorkspace({
			palette: this.palette,
			width,
			height,
			title: this.title(),
			clock: model.available ? formatClock(model.totalActiveMs) : "",
			body,
		});
		this.cachedWidth = width;
		this.cachedHeight = height;
		this.cachedVersion = this.version;
		this.cachedLines = lines;
		return lines;
	}

	private expandedKeys(): ReadonlySet<string> {
		if (!this.expandAll) return EMPTY_SET;
		const keys = new Set<string>();
		for (const row of this.rows) if (row.collapsible) keys.add(row.key);
		return keys;
	}

	private title(): string {
		if (!this.model.available) return "Planner for Local Models";
		return `Planner · ${this.model.planTitle}`;
	}

	/**
	 * Queued messages stacked dimmed above the editor (newest at the bottom,
	 * nearest the input), each clipped to one line. Empty when nothing is queued.
	 */
	private renderQueue(inner: number): string[] {
		if (this.queued.length === 0) return [];
		const lines = this.queued.map((msg) => {
			const oneLine = msg.replace(/\s+/g, " ").trim();
			return clipPad(
				this.palette.dim(`⤷ queued: ${oneLine}`),
				inner,
				this.palette,
			);
		});
		lines.push(
			clipPad(
				this.palette.dim(
					`${this.queued.length} queued — sends when the agent is idle · ${this.keyHint("app.message.dequeue")} edit last`,
				),
				inner,
				this.palette,
			),
		);
		return lines;
	}

	private renderHelpLine(inner: number): string {
		const scroll = `${this.keys.scrollUp.join("/")}/${this.keys.scrollDown.join("/")} (or ${this.keys.pageUp.join("/")}/${this.keys.pageDown.join("/")})`;
		const left =
			this.focus === "tasks"
				? this.palette.accent("tasks")
				: this.palette.dim("editor");
		const keys =
			this.focus === "editor"
				? this.palette.dim(
						`${this.keyHint("tui.input.submit")} send · ${this.keyHint("tui.input.newLine")} newline · ${scroll} scroll · ${this.keyHint("app.tools.expand")} expand · tab tasks · esc exit`,
					)
				: this.palette.dim(
						`↑↓ select task · ${scroll} scroll · type to compose · tab editor · esc exit`,
					);
		return spread(left, keys, inner, this.palette);
	}

	invalidate(): void {
		this.cachedWidth = -1;
		this.cachedHeight = -1;
		this.cachedVersion = -1;
		this.cachedTranscriptKey = "";
		this.cachedTranscript = null;
	}

	dispose(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
		if (this.streamFlushTimer) {
			clearTimeout(this.streamFlushTimer);
			this.streamFlushTimer = null;
		}
		liveStreamListener = null;
		agentIdleListener = null;
	}
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>();

/**
 * Build the EditorTheme pi-tui's Editor needs from our palette: a border color
 * and the autocomplete dropdown styling.
 */
function buildEditorTheme(palette: DashboardPalette): EditorTheme {
	return {
		borderColor: (s) => palette.border(s),
		selectList: {
			selectedPrefix: (s) => palette.accent(s),
			selectedText: (s) => palette.bold(palette.text(s)),
			description: (s) => palette.dim(s),
			scrollInfo: (s) => palette.dim(s),
			noMatch: (s) => palette.dim(s),
		},
	};
}

function clipPad(
	value: string,
	width: number,
	palette: DashboardPalette,
): string {
	const clipped = palette.clip(value, width);
	const pad = Math.max(0, width - palette.measure(clipped));
	return clipped + " ".repeat(pad);
}

function spread(
	left: string,
	right: string,
	width: number,
	palette: DashboardPalette,
): string {
	const lw = palette.measure(left);
	const rw = palette.measure(right);
	if (lw + rw + 1 > width) return clipPad(left, width, palette);
	return left + " ".repeat(width - lw - rw) + right;
}

function buildPalette(theme: Theme): DashboardPalette {
	return {
		text: (s) => theme.fg("text", s),
		accent: (s) => theme.fg("accent", s),
		muted: (s) => theme.fg("muted", s),
		dim: (s) => theme.fg("dim", s),
		success: (s) => theme.fg("success", s),
		warning: (s) => theme.fg("warning", s),
		error: (s) => theme.fg("error", s),
		border: (s) => theme.fg("borderMuted", s),
		bold: (s) => theme.bold(s),
		inverse: (s) => theme.inverse(s),
		stage: (stage, s) => theme.fg(STAGE_THEME_COLOR[stage], s),
		measure: (s) => visibleWidth(s),
		clip: (s, width) => truncateToWidth(s, Math.max(0, width), ""),
	};
}
