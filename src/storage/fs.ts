import { randomUUID } from "node:crypto";
import {
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";

export interface PlannerFs {
	exists(path: string): Promise<boolean>;
	isDirectory(path: string): Promise<boolean>;
	mkdirp(path: string): Promise<void>;
	/** Move a file or directory; parent of `dst` is created first. */
	move(src: string, dst: string): Promise<void>;
	readText(path: string): Promise<string>;
	readdir(path: string): Promise<string[]>;
	removeDir(path: string): Promise<void>;
	removeFile(path: string): Promise<void>;
	writeText(path: string, content: string): Promise<void>;
	writeTextAtomic(path: string, content: string): Promise<void>;
}

export function createNodeFs(): PlannerFs {
	return {
		async exists(path) {
			try {
				await stat(path);
				return true;
			} catch (error) {
				if (isNodeError(error) && error.code === "ENOENT") {
					return false;
				}
				throw error;
			}
		},
		async isDirectory(path) {
			try {
				return (await stat(path)).isDirectory();
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
		async move(src, dst) {
			await mkdir(dirname(dst), { recursive: true });
			await rename(src, dst);
		},
		async readText(path) {
			return await readFile(path, "utf8");
		},
		async readdir(path) {
			return await readdir(path);
		},
		async removeDir(path) {
			await rm(path, { recursive: true, force: true });
		},
		async removeFile(path) {
			try {
				await unlink(path);
			} catch (error) {
				if (isNodeError(error) && error.code === "ENOENT") {
					return;
				}
				throw error;
			}
		},
		async writeText(path, content) {
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, content, "utf8");
		},
		async writeTextAtomic(path, content) {
			// Write-then-rename: a crash or concurrent read mid-write can never
			// observe a partial file. Every JSON store (state/plan/project/task)
			// depends on this — swapping in `writeText` here would let a crash
			// corrupt state.json and break resume.
			await mkdir(dirname(path), { recursive: true });
			const tempPath = `${path}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
			await writeFile(tempPath, content, "utf8");
			await rename(tempPath, path);
		},
	};
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

/**
 * List a directory, returning an empty array if it cannot be read (missing,
 * not a directory, permission denied). Lets callers treat "no entries" and
 * "no such directory" uniformly when scanning optional locations.
 */
export async function safeReaddir(
	fs: PlannerFs,
	path: string,
): Promise<string[]> {
	try {
		return await fs.readdir(path);
	} catch {
		return [];
	}
}
