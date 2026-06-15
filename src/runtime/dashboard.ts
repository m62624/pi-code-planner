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
	buildPlannerDashboardModel,
	composeDashboard,
	type DashboardPalette,
	type DashboardUiState,
	type PlannerDashboardModel,
} from "./dashboard-model";

const MARQUEE_INTERVAL_MS = 180;
/** Reload the model from disk every Nth marquee tick (~1s). */
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
	const open = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI) {
			ctx.ui.notify(
				"The planner dashboard requires interactive mode.",
				"error",
			);
			return;
		}
		const fs = createNodeFs();
		const load = () => loadDashboardModel(fs, ctx.cwd);
		const initial = await load();
		await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
			return new PlannerDashboardComponent({
				tui,
				theme,
				initial,
				load,
				onClose: () => done(undefined),
			});
		});
	};

	pi.registerCommand("planner-dashboard", {
		description:
			"Open the planner dashboard: live stage progress, task list, and session stats.",
		handler: async (_args, ctx) => {
			await open(ctx);
		},
	});

	pi.registerCommand("planner-stats", {
		description: "Alias for /planner-dashboard.",
		handler: async (_args, ctx) => {
			await open(ctx);
		},
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

class PlannerDashboardComponent implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly palette: DashboardPalette;
	private readonly load: () => Promise<PlannerDashboardModel>;
	private readonly onClose: () => void;
	private model: PlannerDashboardModel;
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
	private cachedWidth = -1;
	private cachedHeight = -1;
	private cachedVersion = -1;
	private cachedLines: string[] = [];

	constructor(input: {
		tui: TUI;
		theme: Theme;
		initial: PlannerDashboardModel;
		load: () => Promise<PlannerDashboardModel>;
		onClose: () => void;
	}) {
		this.tui = input.tui;
		this.theme = input.theme;
		this.load = input.load;
		this.onClose = input.onClose;
		this.model = input.initial;
		this.palette = buildPalette(input.theme);
		this.interval = setInterval(() => this.onTick(), MARQUEE_INTERVAL_MS);
		this.interval.unref?.();
	}

	private onTick(): void {
		this.ui.tickerOffset += 1;
		this.version += 1;
		this.tui.requestRender();
		if (this.tick % RELOAD_EVERY_TICKS === 0) void this.reload();
		this.tick += 1;
	}

	private async reload(): Promise<void> {
		if (this.reloading) return;
		this.reloading = true;
		try {
			this.model = await this.load();
			this.clampSelection();
			this.version += 1;
			this.tui.requestRender();
		} catch {
			// Best-effort live refresh; keep the last good model on failure.
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
		if (matchesKey(data, "escape") || data === "q" || data === "Q") {
			this.dispose();
			this.onClose();
			return;
		}
		if (data === "r" || data === "R") {
			void this.reload();
			return;
		}
		if (matchesKey(data, "tab")) {
			this.ui.focus = this.ui.focus === "tasks" ? "ribbon" : "tasks";
			this.bump();
			return;
		}
		if (matchesKey(data, "up")) {
			this.ui.selectedIndex = Math.max(0, this.ui.selectedIndex - 1);
			this.bump();
			return;
		}
		if (matchesKey(data, "down")) {
			const total = this.model.available ? this.model.tasks.length : 0;
			this.ui.selectedIndex = Math.min(
				Math.max(0, total - 1),
				this.ui.selectedIndex + 1,
			);
			this.bump();
			return;
		}
		if (matchesKey(data, "left")) {
			this.ui.tickerOffset -= 4;
			this.bump();
			return;
		}
		if (matchesKey(data, "right")) {
			this.ui.tickerOffset += 4;
			this.bump();
			return;
		}
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
		const lines = composeDashboard({
			model: this.model,
			width,
			height,
			palette: this.palette,
			ui: this.ui,
		});
		this.cachedWidth = width;
		this.cachedHeight = height;
		this.cachedVersion = this.version;
		this.cachedLines = lines;
		return lines;
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
