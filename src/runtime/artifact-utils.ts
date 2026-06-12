import type { PlannerFs } from "../storage/fs";

export async function appendPlannerSection(
	fs: PlannerFs,
	path: string,
	input: {
		heading: string;
		lines: readonly string[];
	},
): Promise<void> {
	const current = (await fs.exists(path)) ? await fs.readText(path) : "";
	const section = [`## ${input.heading}`, "", ...input.lines, ""].join("\n");
	const next = current.trimEnd()
		? `${current.trimEnd()}\n\n${section}`
		: section;
	await fs.writeTextAtomic(path, next);
}
