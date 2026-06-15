import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type Theme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { createNodeFs, type PlannerFs } from "../storage/fs";
import type { ProjectStoragePaths } from "../storage/paths";
import { resolveProjectStoragePaths } from "../storage/project-resolver";
import type { PlannerStage } from "../storage/schema";
import { readActivePlanContext } from "./active-plan";
import {
	type ChatRow,
	projectSessionEntries,
	renderTranscript,
} from "./chat-view";
import {
	buildPlannerDashboardModel,
	type DashboardPalette,
	type DashboardUiState,
	dashboardDivider,
	formatClock,
	frameWorkspace,
	type PlannerDashboardModel,
	renderDashboardBand,
	renderDashboardColumns,
} from "./dashboard-model";

const TICK_MS = 180;
/** Reload the model from disk every Nth tick (~1s). */
const RELOAD_EVERY_TICKS = 6;

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

export function registerPlannerDashboard(pi: ExtensionAPI): void {
	pi.registerCommand("planner-dashboard", {
		description:
			"Open the planner workspace: live stage dashboard, task list, and the model chat in one window.",
		handler: async (_args, ctx) => {
			await openPlannerWorkspace(pi, ctx);
		},
	});
}

export async function openPlannerWorkspace(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("The planner workspace requires interactive mode.", "error");
		return;
	}
	const fs = createNodeFs();
	const load = () => loadDashboardModel(fs, ctx.cwd);
	const getRows = () => projectSessionEntries(ctx.sessionManager.getBranch());
	const initial = await load();
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		return new PlannerWorkspaceComponent({
			tui,
			theme,
			initial,
			initialRows: getRows(),
			load,
			getRows,
			sendUserMessage: (text) => pi.sendUserMessage(text),
			onClose: () => done(undefined),
		});
	});
}

async function loadDashboardModel(
	fs: PlannerFs,
	cwd: string,
): Promise<PlannerDashboardModel> {
	try {
		const projectPaths: ProjectStoragePaths = await resolveProjectStoragePaths({
			fs,
			agentDir: getAgentDir(),
			cwd,
		});
		const context = await readActivePlanContext({ fs, projectPaths });
		return buildPlannerDashboardModel({ context, now: Date.now() });
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

type WorkspaceFocus = "input" | "chat" | "tasks";

class PlannerWorkspaceComponent implements Component {
	private readonly tui: TUI;
	private readonly palette: DashboardPalette;
	private readonly load: () => Promise<PlannerDashboardModel>;
	private readonly getRows: () => ChatRow[];
	private readonly sendUserMessage: (text: string) => void;
	private readonly onClose: () => void;

	private model: PlannerDashboardModel;
	private rows: ChatRow[];
	private input = "";
	private cursor = 0;
	private focus: WorkspaceFocus = "input";
	private chatScroll = 0;
	private expandAll = false;
	private readonly ui: DashboardUiState = {
		selectedIndex: 0,
		taskScroll: 0,
		tickerOffset: 0,
		focus: "tasks",
	};

	private interval: ReturnType<typeof setInterval> | null = null;
	private tick = 0;
	private reloading = false;
	private version = 0;
	private lastTranscriptTotal = 0;
	private lastTranscriptHeight = 1;
	private cachedWidth = -1;
	private cachedHeight = -1;
	private cachedVersion = -1;
	private cachedLines: string[] = [];

	constructor(input: {
		tui: TUI;
		theme: Theme;
		initial: PlannerDashboardModel;
		initialRows: ChatRow[];
		load: () => Promise<PlannerDashboardModel>;
		getRows: () => ChatRow[];
		sendUserMessage: (text: string) => void;
		onClose: () => void;
	}) {
		this.tui = input.tui;
		this.palette = buildPalette(input.theme);
		this.load = input.load;
		this.getRows = input.getRows;
		this.sendUserMessage = input.sendUserMessage;
		this.onClose = input.onClose;
		this.model = input.initial;
		this.rows = input.initialRows;
		this.interval = setInterval(() => this.onTick(), TICK_MS);
		this.interval.unref?.();
	}

	private onTick(): void {
		this.ui.tickerOffset += 1;
		this.refreshRows();
		this.version += 1;
		this.tui.requestRender();
		if (this.tick % RELOAD_EVERY_TICKS === 0) void this.reloadModel();
		this.tick += 1;
	}

	private refreshRows(): void {
		try {
			this.rows = this.getRows();
		} catch {
			// Keep last rows on transient read failure.
		}
	}

	private async reloadModel(): Promise<void> {
		if (this.reloading) return;
		this.reloading = true;
		try {
			this.model = await this.load();
			this.clampSelection();
			this.version += 1;
			this.tui.requestRender();
		} catch {
			// Best-effort.
		} finally {
			this.reloading = false;
		}
	}

	private clampSelection(): void {
		const total = this.model.available ? this.model.tasks.length : 0;
		if (this.ui.selectedIndex > total - 1) {
			this.ui.selectedIndex = Math.max(0, total - 1);
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.dispose();
			this.onClose();
			return;
		}
		if (matchesKey(data, "tab")) {
			this.cycleFocus();
			return;
		}
		if (this.focus === "input") {
			this.handleInputFocus(data);
			return;
		}
		if (this.focus === "chat") {
			this.handleChatFocus(data);
			return;
		}
		this.handleTasksFocus(data);
	}

	private cycleFocus(): void {
		this.focus =
			this.focus === "input"
				? "chat"
				: this.focus === "chat"
					? "tasks"
					: "input";
		this.bump();
	}

	private handleInputFocus(data: string): void {
		if (matchesKey(data, "enter")) {
			this.submit();
			return;
		}
		if (matchesKey(data, "backspace")) {
			if (this.cursor > 0) {
				this.input =
					this.input.slice(0, this.cursor - 1) + this.input.slice(this.cursor);
				this.cursor -= 1;
				this.bump();
			}
			return;
		}
		if (matchesKey(data, "left")) {
			this.cursor = Math.max(0, this.cursor - 1);
			this.bump();
			return;
		}
		if (matchesKey(data, "right")) {
			this.cursor = Math.min(this.input.length, this.cursor + 1);
			this.bump();
			return;
		}
		if (isPrintable(data)) {
			this.input =
				this.input.slice(0, this.cursor) + data + this.input.slice(this.cursor);
			this.cursor += data.length;
			this.bump();
		}
	}

	private handleChatFocus(data: string): void {
		const page = Math.max(1, this.lastTranscriptHeight - 1);
		if (matchesKey(data, "up")) {
			this.scrollChat(1);
		} else if (matchesKey(data, "down")) {
			this.scrollChat(-1);
		} else if (matchesKey(data, "pageUp")) {
			this.scrollChat(page);
		} else if (matchesKey(data, "pageDown")) {
			this.scrollChat(-page);
		} else if (data === "x" || data === "X") {
			this.expandAll = !this.expandAll;
			this.bump();
		}
	}

	private handleTasksFocus(data: string): void {
		const total = this.model.available ? this.model.tasks.length : 0;
		if (matchesKey(data, "up")) {
			this.ui.selectedIndex = Math.max(0, this.ui.selectedIndex - 1);
			this.bump();
		} else if (matchesKey(data, "down")) {
			this.ui.selectedIndex = Math.min(
				Math.max(0, total - 1),
				this.ui.selectedIndex + 1,
			);
			this.bump();
		} else if (matchesKey(data, "left")) {
			this.ui.tickerOffset -= 4;
			this.bump();
		} else if (matchesKey(data, "right")) {
			this.ui.tickerOffset += 4;
			this.bump();
		}
	}

	private scrollChat(delta: number): void {
		const maxScroll = Math.max(
			0,
			this.lastTranscriptTotal - this.lastTranscriptHeight,
		);
		this.chatScroll = Math.min(maxScroll, Math.max(0, this.chatScroll + delta));
		this.bump();
	}

	private submit(): void {
		const text = this.input.trim();
		if (!text) return;
		this.input = "";
		this.cursor = 0;
		this.chatScroll = 0;
		try {
			this.sendUserMessage(text);
		} catch {
			// Ignore send failures; the next refresh will reflect agent state.
		}
		this.bump();
	}

	private bump(): void {
		this.version += 1;
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const height = Math.max(16, this.tui.terminal.rows - 1);
		if (
			width === this.cachedWidth &&
			height === this.cachedHeight &&
			this.version === this.cachedVersion
		) {
			return this.cachedLines;
		}

		const model = this.model;
		const inner = width - 2;
		const bodyHeight = Math.max(1, height - 2);
		const band = renderDashboardBand(
			model,
			inner,
			this.ui.tickerOffset,
			this.palette,
		);

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

		const bottom: string[] = [
			dashboardDivider(inner, this.palette),
			this.renderInputLine(inner),
			this.renderHelpLine(inner),
		];

		const transcriptHeight = Math.max(
			1,
			bodyHeight - top.length - bottom.length,
		);
		const transcript = renderTranscript(
			this.rows,
			{
				width: inner,
				height: transcriptHeight,
				scrollFromBottom: this.chatScroll,
				expanded: this.expandedKeys(),
				focused: this.focus === "chat",
			},
			this.palette,
		);
		this.lastTranscriptTotal = transcript.totalLines;
		this.lastTranscriptHeight = transcriptHeight;

		const body = [...top, ...transcript.lines, ...bottom];
		const lines = frameWorkspace({
			palette: this.palette,
			width,
			height,
			title: this.title(),
			clock: this.model.available ? formatClock(this.model.totalActiveMs) : "",
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

	private renderInputLine(inner: number): string {
		const promptText = "› ";
		const prompt =
			this.focus === "input"
				? this.palette.accent(promptText)
				: this.palette.dim(promptText);
		let body: string;
		if (this.focus === "input") {
			const before = this.input.slice(0, this.cursor);
			const at = this.input.slice(this.cursor, this.cursor + 1) || " ";
			const after = this.input.slice(this.cursor + 1);
			body = `${this.palette.text(before)}${this.palette.inverse(at)}${this.palette.text(after)}`;
		} else if (this.input) {
			body = this.palette.text(this.input);
		} else {
			body = this.palette.dim("type a message, tab to switch panes");
		}
		return clipPad(prompt + body, inner, this.palette);
	}

	private renderHelpLine(inner: number): string {
		const tabs = (["input", "chat", "tasks"] as WorkspaceFocus[])
			.map((f) =>
				f === this.focus ? this.palette.accent(f) : this.palette.dim(f),
			)
			.join(this.palette.dim(" · "));
		const keys =
			this.focus === "input"
				? this.palette.dim("enter send · tab pane · esc exit")
				: this.focus === "chat"
					? this.palette.dim("↑↓ scroll · x expand · tab pane · esc exit")
					: this.palette.dim("↑↓ task · ←→ ribbon · tab pane · esc exit");
		return spread(tabs, keys, inner, this.palette);
	}

	invalidate(): void {
		this.cachedWidth = -1;
		this.cachedHeight = -1;
		this.cachedVersion = -1;
	}

	dispose(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
	}
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>();

function isPrintable(data: string): boolean {
	if (data.length === 0) return false;
	for (let i = 0; i < data.length; i++) {
		const code = data.charCodeAt(i);
		if (code < 32 || code === 127) return false;
	}
	return true;
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
