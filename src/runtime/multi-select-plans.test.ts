import { describe, expect, it } from "vitest";
import { MultiSelectModel, windowAround } from "./multi-select-plans";

describe("MultiSelectModel", () => {
	it("toggles selection and reports ids in list order", () => {
		const model = new MultiSelectModel(["a", "b", "c"]);
		model.toggleCurrent(); // a
		model.moveDown();
		model.moveDown(); // c
		model.toggleCurrent(); // c
		expect(model.selectedIds()).toEqual(["a", "c"]);
		expect(model.selectedCount()).toBe(2);
		expect(model.isSelected("b")).toBe(false);
	});

	it("untoggles on a second toggle", () => {
		const model = new MultiSelectModel(["a", "b"]);
		model.toggleCurrent();
		model.toggleCurrent();
		expect(model.selectedIds()).toEqual([]);
	});

	it("wraps the cursor at both ends", () => {
		const model = new MultiSelectModel(["a", "b", "c"]);
		model.moveUp(); // wraps to last
		expect(model.cursor).toBe(2);
		model.moveDown(); // wraps to first
		expect(model.cursor).toBe(0);
	});

	it("is a no-op on an empty list", () => {
		const model = new MultiSelectModel([]);
		model.moveDown();
		model.toggleCurrent();
		expect(model.selectedIds()).toEqual([]);
		expect(model.cursor).toBe(0);
	});
});

describe("windowAround", () => {
	it("returns the full range when it fits", () => {
		expect(windowAround(0, 3, 12)).toEqual({ start: 0, end: 3 });
	});

	it("centers the cursor and clamps at the start", () => {
		expect(windowAround(0, 100, 10)).toEqual({ start: 0, end: 10 });
	});

	it("centers the cursor and clamps at the end", () => {
		expect(windowAround(99, 100, 10)).toEqual({ start: 90, end: 100 });
	});

	it("keeps the cursor in view in the middle", () => {
		const { start, end } = windowAround(50, 100, 10);
		expect(start).toBeLessThanOrEqual(50);
		expect(end).toBeGreaterThan(50);
		expect(end - start).toBe(10);
	});
});
