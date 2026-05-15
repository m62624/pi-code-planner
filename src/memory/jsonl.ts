import type { PlannerFs } from "../settings/fs";

export function readJsonl<T>(fs: PlannerFs, path: string): T[] {
	if (!fs.exists(path)) return [];
	const content = fs.readFile(path);
	return content
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as T);
}

export function writeJsonl<T>(fs: PlannerFs, path: string, entries: T[]): void {
	const content = entries.map((entry) => JSON.stringify(entry)).join("\n");
	fs.writeFile(path, content.length > 0 ? `${content}\n` : "");
}

export function appendJsonl<T>(
	fs: PlannerFs,
	path: string,
	entries: T[],
): void {
	if (entries.length === 0) return;
	const previous = fs.exists(path) ? fs.readFile(path) : "";
	const prefix = previous.length > 0 && !previous.endsWith("\n") ? "\n" : "";
	const content = entries.map((entry) => JSON.stringify(entry)).join("\n");
	fs.writeFile(path, `${previous}${prefix}${content}\n`);
}

export function upsertJsonlByKey<T>(
	fs: PlannerFs,
	path: string,
	entries: T[],
	keyOf: (entry: T) => string,
): T[] {
	const existing = readJsonl<T>(fs, path);
	const byKey = new Map(existing.map((entry) => [keyOf(entry), entry]));
	for (const entry of entries) {
		byKey.set(keyOf(entry), entry);
	}
	const next = [...byKey.values()];
	writeJsonl(fs, path, next);
	return next;
}
