import { join } from "node:path";
import type { ProjectStoragePaths } from "../storage/paths";
import type { InstructionKey, InstructionPaths } from "./schema";

export function createInstructionPaths(
	projectPaths: ProjectStoragePaths,
): InstructionPaths {
	return {
		instructionsDir: projectPaths.instructionsDir,
		defaultsDir: join(projectPaths.instructionsDir, "defaults"),
		globalAppendDir: join(projectPaths.instructionsDir, "append"),
		projectAppendDir: join(
			projectPaths.projectLocalDir,
			"instructions",
			"append",
		),
	};
}

export function instructionFilePath(dir: string, key: InstructionKey): string {
	return join(dir, `${key}.md`);
}
