import type { PlannerFs } from "../storage/fs";

export class PlannerJsonlError extends Error {
	constructor(
		message: string,
		public readonly path: string,
		public readonly line: number | null,
	) {
		super(message);
		this.name = "PlannerJsonlError";
	}
}

export type JsonlValidator<T> = (value: unknown) => value is T;

export async function readJsonl<T>(
	fs: PlannerFs,
	path: string,
	validate: JsonlValidator<T>,
): Promise<T[]> {
	if (!(await fs.exists(path))) {
		return [];
	}

	const text = await fs.readText(path);
	const entries: T[] = [];
	const lines = text.split(/\r?\n/);
	for (const [index, line] of lines.entries()) {
		if (!line.trim()) {
			continue;
		}
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch (error) {
			if (error instanceof SyntaxError) {
				throw new PlannerJsonlError(
					`Invalid JSONL at ${path}:${index + 1}: ${error.message}`,
					path,
					index + 1,
				);
			}
			throw error;
		}
		if (!validate(value)) {
			throw new PlannerJsonlError(
				`Invalid JSONL entry shape at ${path}:${index + 1}.`,
				path,
				index + 1,
			);
		}
		entries.push(value);
	}
	return entries;
}

export async function writeJsonl<T>(
	fs: PlannerFs,
	path: string,
	entries: readonly T[],
): Promise<void> {
	const content = entries.length
		? `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`
		: "";
	await fs.writeTextAtomic(path, content);
}

export function upsertJsonlEntries<T>(
	current: readonly T[],
	incoming: readonly T[],
	keyOf: (entry: T) => string,
): T[] {
	const byKey = new Map(current.map((entry) => [keyOf(entry), entry]));
	for (const entry of incoming) {
		byKey.set(keyOf(entry), entry);
	}
	return Array.from(byKey.values());
}

export function removeJsonlEntries<T>(
	current: readonly T[],
	keys: readonly string[],
	keyOf: (entry: T) => string,
): T[] {
	const deleted = new Set(keys);
	return current.filter((entry) => !deleted.has(keyOf(entry)));
}
