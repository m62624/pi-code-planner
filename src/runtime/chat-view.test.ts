import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	type ChatRow,
	projectSessionEntries,
	renderTranscript,
	type TranscriptOptions,
} from "./chat-view";
import type { DashboardPalette } from "./dashboard-model";

const palette: DashboardPalette = {
	text: (s) => s,
	accent: (s) => s,
	muted: (s) => s,
	dim: (s) => s,
	success: (s) => s,
	warning: (s) => s,
	error: (s) => s,
	border: (s) => s,
	bold: (s) => s,
	inverse: (s) => s,
	stage: (_stage, s) => s,
	measure: (s) => s.length,
	clip: (s, width) => (s.length <= width ? s : s.slice(0, Math.max(0, width))),
};

function messageEntry(id: string, message: unknown): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-06-15T00:00:00.000Z",
		message,
	} as SessionEntry;
}

function baseOptions(over: Partial<TranscriptOptions> = {}): TranscriptOptions {
	return {
		width: 60,
		height: 10,
		atBottom: true,
		topLine: 0,
		expanded: new Set(),
		...over,
	};
}

describe("projectSessionEntries", () => {
	it("projects user, assistant text, tool calls, and tool results", () => {
		const entries: SessionEntry[] = [
			messageEntry("u1", { role: "user", content: "hello model" }),
			messageEntry("a1", {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "let me think" },
					{ type: "text", text: "Sure, doing it." },
					{
						type: "toolCall",
						name: "planner_status",
						arguments: { verbose: true },
					},
				],
			}),
			messageEntry("r1", {
				role: "toolResult",
				toolName: "planner_status",
				isError: false,
				content: [{ type: "text", text: "stage: execution" }],
			}),
		];

		const rows = projectSessionEntries(entries);
		const roles = rows.map((r) => r.role);
		expect(roles).toContain("user");
		expect(roles).toContain("thinking");
		expect(roles).toContain("assistant");
		expect(roles).toContain("tool");
		expect(roles).toContain("tool_result");

		const tool = rows.find((r) => r.role === "tool") as ChatRow;
		expect(tool.label).toBe("planner_status");
		expect(tool.text).toContain("verbose=true");

		const result = rows.find((r) => r.role === "tool_result") as ChatRow;
		expect(result.isError).toBe(false);
	});

	it("marks tool result errors and skips hidden custom messages", () => {
		const entries: SessionEntry[] = [
			messageEntry("r1", {
				role: "toolResult",
				toolName: "planner_git_commit",
				isError: true,
				content: [{ type: "text", text: "blocked" }],
			}),
			{
				type: "custom_message",
				id: "c1",
				parentId: null,
				timestamp: "2026-06-15T00:00:00.000Z",
				customType: "planner-internal",
				content: "hidden",
				display: false,
			} as SessionEntry,
		];
		const rows = projectSessionEntries(entries);
		expect(rows).toHaveLength(1);
		expect(rows[0].isError).toBe(true);
	});
});

describe("renderTranscript", () => {
	const rows: ChatRow[] = [
		{ role: "user", text: "first question", collapsible: false, key: "u1" },
		{
			role: "assistant",
			text: "a long answer ".repeat(10).trim(),
			collapsible: false,
			key: "a1",
		},
		{
			role: "tool",
			label: "planner_status",
			text: "verbose=true extra=1",
			collapsible: true,
			key: "t1",
		},
	];

	it("returns exactly height lines bounded to width", () => {
		const result = renderTranscript(rows, baseOptions(), palette);
		expect(result.lines).toHaveLength(10);
		for (const line of result.lines) {
			expect(line.length).toBe(60);
		}
	});

	it("collapses tool rows to a single line by default and expands on demand", () => {
		const longTool: ChatRow[] = [
			{
				role: "tool",
				label: "planner_status",
				text: "line one\nline two\nline three",
				collapsible: true,
				key: "t1",
			},
		];
		const collapsed = renderTranscript(longTool, baseOptions(), palette);
		const collapsedText = collapsed.lines.join("\n");
		expect(collapsedText).toContain("…");

		const expanded = renderTranscript(
			longTool,
			baseOptions({ expanded: new Set(["t1"]) }),
			palette,
		);
		const expandedText = expanded.lines.join("\n");
		expect(expandedText).toContain("line two");
		expect(expandedText).toContain("line three");
	});

	it("expands tabs and strips control bytes so the frame stays aligned", () => {
		const tabbed: ChatRow[] = [
			{
				role: "assistant",
				text: "\t\tconst x = 1;\u001b[31mred\u001b[0m",
				collapsible: false,
				key: "a1",
			},
		];
		const result = renderTranscript(
			tabbed,
			baseOptions({ width: 40 }),
			palette,
		);
		const joined = result.lines.join("\n");
		expect(joined).not.toContain("\t");
		expect(joined).not.toContain("\u001b");
		expect(joined).toContain("const x = 1;red");
		for (const line of result.lines) {
			expect(line.length).toBe(40);
		}
	});

	it("never truncates a long non-collapsible assistant message", () => {
		// A streaming answer far past the old 40-wrapped-line cap: every line
		// must exist in the transcript so tail-following keeps showing new text.
		const lineCount = 120;
		const text = Array.from(
			{ length: lineCount },
			(_, i) => `answer line ${i}`,
		).join("\n");
		const long: ChatRow[] = [
			{ role: "assistant", text, collapsible: false, key: "a1" },
		];
		const result = renderTranscript(
			long,
			baseOptions({ height: 5, atBottom: true }),
			palette,
		);
		expect(result.totalLines).toBe(lineCount);
		// Tail-following shows the newest lines, not a frozen first chunk.
		const tail = result.lines.join("\n");
		expect(tail).toContain(`answer line ${lineCount - 1}`);

		// The full content is reachable by scrolling.
		const middle = renderTranscript(
			long,
			baseOptions({ height: 5, atBottom: false, topLine: 60 }),
			palette,
		);
		expect(middle.lines.join("\n")).toContain("answer line 60");
	});

	it("still caps expanded collapsible rows at the expanded limit", () => {
		const text = Array.from({ length: 80 }, (_, i) => `tool line ${i}`).join(
			"\n",
		);
		const rows: ChatRow[] = [
			{
				role: "tool",
				label: "planner_status",
				text,
				collapsible: true,
				key: "t1",
			},
		];
		const expanded = renderTranscript(
			rows,
			baseOptions({ height: 100, expanded: new Set(["t1"]) }),
			palette,
		);
		// 40 wrapped lines max for an expanded collapsible row.
		expect(expanded.totalLines).toBe(40);
	});

	it("shows an empty-state hint when there are no rows", () => {
		const result = renderTranscript([], baseOptions(), palette);
		expect(result.lines.join("\n")).toContain("No conversation yet");
	});

	it("anchors to an absolute top line and stays put as content appends", () => {
		const make = (n: number): ChatRow[] =>
			Array.from({ length: n }, (_, i) => ({
				role: "user" as const,
				text: `message ${i}`,
				collapsible: false,
				key: `m${i}`,
			}));

		const bottom = renderTranscript(make(40), baseOptions(), palette);
		expect(bottom.totalLines).toBe(40);
		expect(bottom.topLine).toBe(30);

		// Anchored at top line 5; appending more rows must NOT move the view.
		const before = renderTranscript(
			make(40),
			baseOptions({ atBottom: false, topLine: 5 }),
			palette,
		);
		const after = renderTranscript(
			make(60),
			baseOptions({ atBottom: false, topLine: 5 }),
			palette,
		);
		expect(after.topLine).toBe(5);
		expect(after.lines.join("\n")).toBe(before.lines.join("\n"));
	});
});
