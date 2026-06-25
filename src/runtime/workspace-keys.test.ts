import { describe, expect, it } from "vitest";
import {
	buildWorkspaceKeyHints,
	resolvePiKeyHint,
	resolveWorkspaceKeys,
} from "./workspace-keys";

describe("resolveWorkspaceKeys", () => {
	it("falls back to defaults and applies non-empty overrides", () => {
		const resolved = resolveWorkspaceKeys({ expand: ["x", "o"], jumpTop: [] });
		expect(resolved.expand).toEqual(["x", "o"]);
		// Empty override is ignored — the default stands.
		expect(resolved.jumpTop).toEqual(["home"]);
		expect(resolved.focusNext).toEqual(["tab"]);
	});
});

describe("resolvePiKeyHint", () => {
	it("returns Pi's default when there is no override", () => {
		expect(resolvePiKeyHint("tui.input.newLine", undefined)).toBe(
			"shift+enter",
		);
		expect(resolvePiKeyHint("tui.input.submit", {})).toBe("enter");
	});

	it("returns the user's override when present", () => {
		expect(
			resolvePiKeyHint("tui.input.newLine", {
				"tui.input.newLine": ["ctrl+j"],
			}),
		).toBe("ctrl+j");
		expect(
			resolvePiKeyHint("app.message.dequeue", {
				"app.message.dequeue": "alt+k",
			}),
		).toBe("alt+k");
	});
});

describe("buildWorkspaceKeyHints", () => {
	it("combines Pi overrides with resolved workspace keys", () => {
		const hints = buildWorkspaceKeyHints({
			workspaceKeys: resolveWorkspaceKeys({ focusNext: ["tab", "ctrl+w"] }),
			piOverrides: { "tui.input.newLine": ["ctrl+j"] },
		});
		expect(hints.newline).toBe("ctrl+j");
		expect(hints.send).toBe("enter");
		expect(hints.dequeue).toBe("alt+up");
		expect(hints.focusNext).toBe("tab/ctrl+w");
		expect(hints.scroll).toBe("up/down");
	});
});
