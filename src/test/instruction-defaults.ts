import { instructionFilePath } from "../instructions/paths";
import {
	INSTRUCTION_KEYS,
	type InstructionDefaults,
} from "../instructions/schema";
import type { PlannerFs } from "../storage/fs";

export const TEST_INSTRUCTION_DEFAULTS = Object.fromEntries(
	INSTRUCTION_KEYS.map((key) => [key, `# ${key}\n`]),
) as InstructionDefaults;

export async function seedInstructionDefaults(
	fs: PlannerFs,
	defaultsDir: string,
	defaults: InstructionDefaults = TEST_INSTRUCTION_DEFAULTS,
): Promise<void> {
	for (const key of INSTRUCTION_KEYS) {
		await fs.writeTextAtomic(
			instructionFilePath(defaultsDir, key),
			defaults[key],
		);
	}
}
