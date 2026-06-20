import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { installPlannerToolErrorBoundary } from "./index";

type Registered = Parameters<ExtensionAPI["registerTool"]>[0];

function createMockPi(): {
	pi: ExtensionAPI;
	registered: Registered[];
} {
	const registered: Registered[] = [];
	const pi = {
		registerTool: (tool: Registered) => {
			registered.push(tool);
		},
	} as unknown as ExtensionAPI;
	return { pi, registered };
}

describe("installPlannerToolErrorBoundary", () => {
	it("converts a thrown error into an error result instead of letting it escape", async () => {
		const { pi, registered } = createMockPi();
		installPlannerToolErrorBoundary(pi);

		pi.registerTool({
			name: "planner_questions_submit",
			label: "Q",
			description: "d",
			parameters: {} as never,
			async execute() {
				throw new TypeError("hasOpenQuestions must be boolean.");
			},
		});

		const tool = registered[0];
		const result = await tool.execute(
			"call-1",
			{} as never,
			undefined,
			undefined,
			{ cwd: "/repo" } as never,
		);

		expect(result.isError).toBe(true);
		expect(result.content[0]).toMatchObject({ type: "text" });
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("planner_questions_submit failed");
		expect(text).toContain("hasOpenQuestions must be boolean.");
		expect(result.details).toMatchObject({
			toolName: "planner_questions_submit",
		});
	});

	it("passes successful results through untouched", async () => {
		const { pi, registered } = createMockPi();
		installPlannerToolErrorBoundary(pi);

		const ok = {
			content: [{ type: "text" as const, text: "all good" }],
			details: { ok: true },
		};
		pi.registerTool({
			name: "planner_status",
			label: "S",
			description: "d",
			parameters: {} as never,
			async execute() {
				return ok;
			},
		});

		const result = await registered[0].execute(
			"call-1",
			{} as never,
			undefined,
			undefined,
			{ cwd: "/repo" } as never,
		);

		expect(result).toEqual(ok);
		expect(result.isError).toBeUndefined();
	});

	it("normalizes non-Error throws to a string message", async () => {
		const { pi, registered } = createMockPi();
		installPlannerToolErrorBoundary(pi);

		pi.registerTool({
			name: "planner_task_upsert",
			label: "T",
			description: "d",
			parameters: {} as never,
			async execute() {
				throw "boom";
			},
		});

		const result = await registered[0].execute(
			"call-1",
			{} as never,
			undefined,
			undefined,
			{ cwd: "/repo" } as never,
		);

		expect(result.isError).toBe(true);
		expect((result.content[0] as { text: string }).text).toContain("boom");
	});
});
