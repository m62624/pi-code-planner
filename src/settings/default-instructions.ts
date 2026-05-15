import { readFileSync } from "node:fs";
import type { InstructionName } from "./schema";

const DEFAULT_INSTRUCTION_FILES: Record<InstructionName, string> = {
	discovery: "discovery.md",
	plan: "plan.md",
	work_item: "work_item.md",
	refactor: "refactor.md",
	api_check: "api_check.md",
	documentation: "documentation.md",
	compact: "compact.md",
	commit_style: "commit_style.md",
};

export function readDefaultInstructionContent(name: InstructionName): string {
	return readFileSync(
		new URL(
			`../instructions/defaults/${DEFAULT_INSTRUCTION_FILES[name]}`,
			import.meta.url,
		),
		"utf8",
	);
}
