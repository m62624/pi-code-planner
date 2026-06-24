import { type KeyId, matchesKey } from "@earendil-works/pi-tui";

/**
 * Pure selection state for the multi-select plan picker. Kept free of any TUI
 * dependency so the navigation/toggle logic is unit-testable; the component
 * below is a thin render/input shell around it.
 */
export class MultiSelectModel {
	cursor = 0;
	private readonly selected = new Set<string>();
	private readonly ids: readonly string[];

	constructor(ids: readonly string[]) {
		this.ids = ids;
	}

	moveUp(): void {
		if (this.ids.length === 0) return;
		this.cursor = this.cursor <= 0 ? this.ids.length - 1 : this.cursor - 1;
	}

	moveDown(): void {
		if (this.ids.length === 0) return;
		this.cursor = this.cursor >= this.ids.length - 1 ? 0 : this.cursor + 1;
	}

	toggleCurrent(): void {
		const id = this.ids[this.cursor];
		if (id === undefined) return;
		if (this.selected.has(id)) this.selected.delete(id);
		else this.selected.add(id);
	}

	isSelected(id: string): boolean {
		return this.selected.has(id);
	}

	selectedCount(): number {
		return this.selected.size;
	}

	/** Selected ids in the original list order. */
	selectedIds(): string[] {
		return this.ids.filter((id) => this.selected.has(id));
	}
}

/** Visible row range that keeps the cursor in view for a scrolling list. */
export function windowAround(
	cursor: number,
	total: number,
	maxVisible: number,
): { start: number; end: number } {
	if (total <= maxVisible) return { start: 0, end: total };
	let start = cursor - Math.floor(maxVisible / 2);
	if (start < 0) start = 0;
	if (start + maxVisible > total) start = total - maxVisible;
	return { start, end: start + maxVisible };
}

export interface DeletablePlan {
	planId: string;
	label: string;
	active: boolean;
}

/** Minimal surface of ctx.ui needed to present the picker (eases typing/tests). */
export interface CustomOverlayUi {
	custom<T>(
		factory: (
			tui: { requestRender(): void },
			theme: {
				fg(role: string, text: string): string;
				bold(text: string): string;
			},
			keybindings: unknown,
			done: (result: T) => void,
		) => {
			render(width: number): string[];
			invalidate(): void;
			handleInput(data: string): void;
		},
	): Promise<T>;
}

const MAX_VISIBLE_ROWS = 12;

/**
 * Show a checkbox multi-select of plans. Returns the chosen plan ids (possibly
 * empty) on confirm, or null on cancel. Space toggles, Enter confirms, Esc
 * cancels, ↑↓/jk move.
 */
export async function pickPlansToDelete(
	ui: CustomOverlayUi,
	plans: readonly DeletablePlan[],
): Promise<string[] | null> {
	if (plans.length === 0) return [];
	return await ui.custom<string[] | null>((tui, theme, _kb, done) => {
		const model = new MultiSelectModel(plans.map((plan) => plan.planId));
		const maxVisible = Math.min(plans.length, MAX_VISIBLE_ROWS);
		return {
			render(_width: number): string[] {
				const lines: string[] = [
					theme.fg("accent", theme.bold("Delete planner plans")),
					theme.fg(
						"dim",
						"↑↓/jk move · space toggle · enter delete selected · esc cancel",
					),
					"",
				];
				const { start, end } = windowAround(
					model.cursor,
					plans.length,
					maxVisible,
				);
				for (let i = start; i < end; i++) {
					const plan = plans[i];
					if (!plan) continue;
					const isCursor = i === model.cursor;
					const checked = model.isSelected(plan.planId);
					const cursorGlyph = isCursor ? theme.fg("accent", "›") : " ";
					const box = checked ? theme.fg("accent", "[x]") : "[ ]";
					const label = plan.active ? `${plan.label} (active)` : plan.label;
					lines.push(
						`${cursorGlyph} ${box} ${isCursor ? theme.fg("accent", label) : label}`,
					);
				}
				lines.push("");
				lines.push(theme.fg("dim", `${model.selectedCount()} selected`));
				return lines;
			},
			invalidate() {},
			handleInput(data: string) {
				const is = (id: KeyId) => matchesKey(data, id);
				if (is("up") || is("k")) model.moveUp();
				else if (is("down") || is("j")) model.moveDown();
				else if (is("space")) model.toggleCurrent();
				else if (is("enter") || is("return")) {
					done(model.selectedIds());
					return;
				} else if (is("escape") || is("esc")) {
					done(null);
					return;
				}
				tui.requestRender();
			},
		};
	});
}
