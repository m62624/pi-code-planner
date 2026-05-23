import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface PlannerFs {
	exists(path: string): Promise<boolean>;
	mkdirp(path: string): Promise<void>;
	readText(path: string): Promise<string>;
	writeText(path: string, content: string): Promise<void>;
	writeTextAtomic(path: string, content: string): Promise<void>;
}

export function createNodeFs(): PlannerFs {
	return {
		async exists(path) {
			try {
				await readFile(path);
				return true;
			} catch (error) {
				if (isNodeError(error) && error.code === "ENOENT") {
					return false;
				}
				throw error;
			}
		},
		async mkdirp(path) {
			await mkdir(path, { recursive: true });
		},
		async readText(path) {
			return await readFile(path, "utf8");
		},
		async writeText(path, content) {
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, content, "utf8");
		},
		async writeTextAtomic(path, content) {
			await mkdir(dirname(path), { recursive: true });
			const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
			await writeFile(tempPath, content, "utf8");
			await rename(tempPath, path);
		},
	};
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
