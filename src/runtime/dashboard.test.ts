import { describe, expect, it } from "vitest";
import { PlannerWorkspaceComponent } from "./dashboard";

/**
 * Behavioral tests for the workspace wrapper around Pi's native Editor: the
 * message queue, Alt+Up dequeue, queue flush, and overlay focus gating. The
 * editor's own text editing (typing, newline, submit, paste markers) is pi-tui's
 * concern and is not retested here. TUI/theme/keybindings are faked.
 */

type Sent = { text: string; queued: boolean };

function makeComponent(opts: { busy: boolean }) {
	const sent: Sent[] = [];
	let busy = opts.busy;
	let renderCount = 0;
	const idColor = (s: string) => s;
	const theme = {
		fg: (_role: string, s: string) => s,
		bold: idColor,
		inverse: idColor,
	} as never;
	const tui = {
		requestRender() {
			renderCount += 1;
		},
		terminal: { rows: 40 },
	} as never;
	// Fake keybindings: only the dequeue action is needed here (the editor uses
	// the global keybindings internally for its own keys).
	const keybindings = {
		matches(data: string, id: string) {
			return id === "app.message.dequeue" && data === "<alt+up>";
		},
		getKeys: () => [] as string[],
	} as never;
	const keys = {
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
	} as never;
	const component = new PlannerWorkspaceComponent({
		tui,
		theme,
		keybindings,
		keys,
		initial: { available: false, reason: "n/a", hint: "n/a" },
		footerReserve: 3,
		load: async () => ({ available: false, reason: "n/a", hint: "n/a" }),
		getEntries: () => [],
		messaging: {
			isAgentBusy: () => busy,
			send: (text) => sent.push({ text, queued: false }),
			sendQueued: (text) => sent.push({ text, queued: true }),
		},
		onClose: () => {},
	});
	const access = component as unknown as {
		queued: string[];
		flushQueue: () => void;
		scheduleRender: () => void;
		onEditorSubmit: (text: string) => void;
		editor: { getText: () => string };
	};
	let focused = true;
	let hidden = false;
	const attachHandle = () => {
		component.attachHandle({
			isFocused: () => focused,
			hide() {},
			setHidden(h: boolean) {
				hidden = h;
			},
			isHidden: () => hidden,
			focus() {},
			unfocus() {},
		} as never);
	};
	const tickAccess = component as unknown as { onTick: () => void };
	return {
		component,
		access,
		sent,
		setBusy: (b: boolean) => {
			busy = b;
		},
		attachHandle,
		setFocused: (f: boolean) => {
			focused = f;
		},
		renderCount: () => renderCount,
		isHidden: () => hidden,
		tick: () => tickAccess.onTick(),
	};
}

describe("PlannerWorkspaceComponent queue", () => {
	it("sends immediately when the agent is idle", () => {
		const { access, sent } = makeComponent({ busy: false });
		access.onEditorSubmit("hello");
		expect(sent).toEqual([{ text: "hello", queued: false }]);
		expect(access.queued).toEqual([]);
	});

	it("queues submissions while the agent is busy", () => {
		const { access, sent } = makeComponent({ busy: true });
		access.onEditorSubmit("first");
		access.onEditorSubmit("second");
		expect(sent).toHaveLength(0);
		expect(access.queued).toEqual(["first", "second"]);
	});

	it("restores the last queued message into the editor on Alt+Up", () => {
		const { component, access } = makeComponent({ busy: true });
		access.onEditorSubmit("draft");
		expect(access.queued).toEqual(["draft"]);
		component.handleInput("<alt+up>");
		expect(access.queued).toEqual([]);
		expect(access.editor.getText()).toBe("draft");
	});

	it("flushes the queue in FIFO order as follow-ups when the agent goes idle", () => {
		const { access, sent, setBusy } = makeComponent({ busy: true });
		access.onEditorSubmit("one");
		access.onEditorSubmit("two");
		setBusy(false);
		access.flushQueue();
		expect(sent).toEqual([
			{ text: "one", queued: true },
			{ text: "two", queued: true },
		]);
		expect(access.queued).toEqual([]);
	});
});

describe("PlannerWorkspaceComponent overlay focus", () => {
	it("hides itself but keeps repainting while a foreign overlay is focused", () => {
		const { attachHandle, setFocused, renderCount, isHidden, tick } =
			makeComponent({ busy: false });
		attachHandle();
		setFocused(false);
		const before = renderCount();
		tick();
		// Yields the top layer (hidden) but still requests a render so the foreign
		// overlay's timers stay live — the freeze was caused by stopping repaints.
		expect(isHidden()).toBe(true);
		expect(renderCount()).toBeGreaterThan(before);
	});

	it("unhides and repaints when focus returns", () => {
		const { attachHandle, setFocused, isHidden, tick } = makeComponent({
			busy: false,
		});
		attachHandle();
		setFocused(false);
		tick();
		expect(isHidden()).toBe(true);
		setFocused(true);
		tick();
		expect(isHidden()).toBe(false);
	});

	it("ignores input that reaches it while not the focused overlay", () => {
		const { component, access, attachHandle, setFocused } = makeComponent({
			busy: false,
		});
		attachHandle();
		setFocused(false);
		component.handleInput("x");
		expect(access.editor.getText()).toBe("");
	});
});
