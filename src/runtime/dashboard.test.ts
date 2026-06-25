import { describe, expect, it } from "vitest";
import { PlannerWorkspaceComponent } from "./dashboard";

/**
 * Behavioral tests for the workspace composer and message queue. The component
 * is driven through its public handleInput(); TUI/theme/keybindings are faked
 * since these tests assert state, not rendered pixels.
 */

type Sent = { text: string; queued: boolean };

function makeComponent(opts: { busy: boolean }) {
	const sent: Sent[] = [];
	let busy = opts.busy;
	const idColor = (s: string) => s;
	const theme = {
		fg: (_role: string, s: string) => s,
		bold: idColor,
		inverse: idColor,
	} as never;
	const tui = {
		requestRender() {},
		terminal: { rows: 40 },
	} as never;
	// Fake keybindings: submit on "\r", newline on the shift+enter marker, dequeue
	// on the alt+up marker. Everything else is not a bound action.
	const keybindings = {
		matches(data: string, id: string) {
			if (id === "tui.input.submit") return data === "\r";
			if (id === "tui.input.newLine") return data === "<shift+enter>";
			if (id === "app.message.dequeue") return data === "<alt+up>";
			return false;
		},
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
		input: string;
		queued: string[];
		flushQueue: () => void;
	};
	return {
		component,
		access,
		sent,
		setBusy: (b: boolean) => {
			busy = b;
		},
	};
}

function type(component: PlannerWorkspaceComponent, text: string): void {
	for (const ch of text) component.handleInput(ch);
}

describe("PlannerWorkspaceComponent composer", () => {
	it("inserts a newline for a bare LF (ctrl+j) instead of submitting", () => {
		const { component, access, sent } = makeComponent({ busy: false });
		type(component, "ab");
		component.handleInput("\n");
		type(component, "cd");
		expect(access.input).toBe("ab\ncd");
		expect(sent).toHaveLength(0);
	});

	it("inserts a newline for shift+enter", () => {
		const { component, access } = makeComponent({ busy: false });
		type(component, "x");
		component.handleInput("<shift+enter>");
		type(component, "y");
		expect(access.input).toBe("x\ny");
	});

	it("submits on enter and sends immediately when the agent is idle", () => {
		const { component, access, sent } = makeComponent({ busy: false });
		type(component, "hello");
		component.handleInput("\r");
		expect(sent).toEqual([{ text: "hello", queued: false }]);
		expect(access.input).toBe("");
	});
});

describe("PlannerWorkspaceComponent queue", () => {
	it("queues messages typed while the agent is busy instead of sending", () => {
		const { component, access, sent } = makeComponent({ busy: true });
		type(component, "first");
		component.handleInput("\r");
		type(component, "second");
		component.handleInput("\r");
		expect(sent).toHaveLength(0);
		expect(access.queued).toEqual(["first", "second"]);
	});

	it("restores the last queued message into the composer on Alt+Up", () => {
		const { component, access } = makeComponent({ busy: true });
		type(component, "draft");
		component.handleInput("\r");
		expect(access.queued).toEqual(["draft"]);
		component.handleInput("<alt+up>");
		expect(access.queued).toEqual([]);
		expect(access.input).toBe("draft");
	});

	it("flushes the queue in FIFO order as follow-ups when the agent goes idle", () => {
		const { component, access, sent, setBusy } = makeComponent({ busy: true });
		type(component, "one");
		component.handleInput("\r");
		type(component, "two");
		component.handleInput("\r");
		setBusy(false);
		access.flushQueue();
		expect(sent).toEqual([
			{ text: "one", queued: true },
			{ text: "two", queued: true },
		]);
		expect(access.queued).toEqual([]);
	});
});
