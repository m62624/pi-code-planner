import type { PlannerFs } from "./fs";

export class PlannerJsonError extends Error {
	constructor(
		message: string,
		public readonly path: string,
	) {
		super(message);
		this.name = "PlannerJsonError";
	}
}

export async function readJson<T>(fs: PlannerFs, path: string): Promise<T> {
	try {
		return JSON.parse(await fs.readText(path)) as T;
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new PlannerJsonError(
				`Invalid JSON at ${path}: ${error.message}`,
				path,
			);
		}
		throw error;
	}
}

export async function writeJson<T>(
	fs: PlannerFs,
	path: string,
	value: T,
): Promise<void> {
	await fs.writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJsonIfExists<T>(
	fs: PlannerFs,
	path: string,
): Promise<T | null> {
	if (!(await fs.exists(path))) {
		return null;
	}
	return await readJson<T>(fs, path);
}
