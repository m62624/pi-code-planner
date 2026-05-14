import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export interface PlannerFs {
	exists(path: string): boolean;
	mkdirp(path: string): void;
	readFile(path: string): string;
	writeFile(path: string, content: string): void;
	rename(from: string, to: string): void;
}

export function createNodeFs(): PlannerFs {
	return {
		exists(path) {
			return existsSync(path);
		},
		mkdirp(path) {
			mkdirSync(path, { recursive: true });
		},
		readFile(path) {
			return readFileSync(path, "utf-8");
		},
		writeFile(path, content) {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content, "utf-8");
		},
		rename(from, to) {
			renameSync(from, to);
		},
	};
}

export function writeJsonAtomic(
	fs: PlannerFs,
	path: string,
	value: unknown,
): void {
	const tmpPath = `${path}.tmp`;
	fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`);
	fs.rename(tmpPath, path);
}
