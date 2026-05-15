import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { CompactionCoordinator } from "../compaction/coordinator";
import { createPlannerCompactionTools } from "./planner-compaction-tools";

function context(): ExtensionContext {
	return {
		cwd: "/repo",
	} as ExtensionContext;
}

describe("createPlannerCompactionTools", () => {
	it("registers provider-safe compaction tool names", () => {
		const tools = createPlannerCompactionTools(
			() => ({}) as CompactionCoordinator,
		);

		expect(tools.map((tool) => tool.name)).toEqual(["planner_request_compact"]);
	});

	it("requests compaction through the coordinator", async () => {
		const requestCompact = vi.fn().mockReturnValue({
			kind: "started",
			pending: { id: "compact-1", status: "requested" },
		});
		const compactor = { requestCompact } as unknown as CompactionCoordinator;
		const tool = createPlannerCompactionTools(() => compactor)[0];

		const result = await tool.execute(
			"call-1",
			{
				reason: "work_item",
				customInstructions: "compact work item",
				resumePrompt: "resume work item",
			},
			undefined,
			undefined,
			context(),
		);

		expect(requestCompact).toHaveBeenCalledWith(context(), {
			reason: "work_item",
			customInstructions: "compact work item",
			resumePrompt: "resume work item",
		});
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: "Planner compaction requested.",
		});
		expect(result.details).toMatchObject({
			kind: "started",
			pending: { id: "compact-1" },
		});
	});

	it("reports an already pending compaction without starting another one", async () => {
		const requestCompact = vi.fn().mockReturnValue({
			kind: "already_pending",
			pending: { id: "compact-1", status: "completed" },
		});
		const compactor = { requestCompact } as unknown as CompactionCoordinator;
		const tool = createPlannerCompactionTools(() => compactor)[0];

		const result = await tool.execute(
			"call-1",
			{
				reason: "manual",
				customInstructions: "compact",
				resumePrompt: "resume",
			},
			undefined,
			undefined,
			context(),
		);

		expect(result.content[0]).toMatchObject({
			type: "text",
			text: "Planner compaction is already pending.",
		});
		expect(result.details).toMatchObject({
			kind: "already_pending",
			pending: { id: "compact-1" },
		});
	});

	it("blocks compaction when project memory is dirty", async () => {
		const requestCompact = vi.fn();
		const compactor = { requestCompact } as unknown as CompactionCoordinator;
		const tool = createPlannerCompactionTools(
			() => compactor,
			() => ({
				files: {
					"src/config.ts": {
						filePath: "src/config.ts",
						reason: "edit result",
						markedAt: "2026-05-15T00:00:00.000Z",
					},
				},
			}),
		)[0];

		const result = await tool.execute(
			"call-1",
			{
				reason: "manual",
				customInstructions: "compact",
				resumePrompt: "resume",
			},
			undefined,
			undefined,
			context(),
		);

		expect(requestCompact).not.toHaveBeenCalled();
		expect(result.content[0].text).toBe(
			"Project memory has 1 dirty file(s); run signature_refresh before request_compact.",
		);
		expect(result.details).toMatchObject({
			memoryPolicy: {
				kind: "block",
				dirtyFiles: ["src/config.ts"],
			},
		});
	});
});
