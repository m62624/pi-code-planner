import { dirname, normalize } from "node:path";
import type { PlannerFs } from "../storage/fs";

export class MockPlannerFs implements PlannerFs {
	private readonly files = new Map<string, string>();
	readonly dirs = new Set<string>();
	readonly atomicWrites: string[] = [];

	async exists(path: string): Promise<boolean> {
		const key = normalize(path);
		return this.files.has(key) || this.dirs.has(key);
	}

	async readdir(path: string): Promise<string[]> {
		const normalized = normalize(path);
		const entries = new Set<string>();
		for (const file of this.files.keys()) {
			if (file === normalized) {
				continue;
			}
			if (!file.startsWith(`${normalized}/`)) {
				continue;
			}
			const relative = file.slice(normalized.length + 1);
			const top = relative.split("/")[0];
			if (top) {
				entries.add(top);
			}
		}
		for (const dir of this.dirs) {
			if (dir === normalized) {
				continue;
			}
			if (!dir.startsWith(`${normalized}/`)) {
				continue;
			}
			const relative = dir.slice(normalized.length + 1);
			const top = relative.split("/")[0];
			if (top) {
				entries.add(top);
			}
		}
		return [...entries];
	}

	async mkdirp(path: string): Promise<void> {
		let current = normalize(path);
		const parts: string[] = [];
		while (current && current !== dirname(current)) {
			parts.push(current);
			current = dirname(current);
		}
		for (const dir of parts.reverse()) {
			this.dirs.add(dir);
		}
		this.dirs.add(normalize(path));
	}

	async readText(path: string): Promise<string> {
		const key = normalize(path);
		const value = this.files.get(key);
		if (value === undefined) {
			throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
		}
		return value;
	}

	async removeDir(path: string): Promise<void> {
		const key = normalize(path);
		for (const file of [...this.files.keys()]) {
			if (file === key || file.startsWith(`${key}/`)) {
				this.files.delete(file);
			}
		}
		for (const dir of [...this.dirs]) {
			if (dir === key || dir.startsWith(`${key}/`)) {
				this.dirs.delete(dir);
			}
		}
	}

	async removeFile(path: string): Promise<void> {
		this.files.delete(normalize(path));
	}

	async writeText(path: string, content: string): Promise<void> {
		await this.mkdirp(dirname(path));
		this.files.set(normalize(path), content);
	}

	async writeTextAtomic(path: string, content: string): Promise<void> {
		await this.writeText(path, content);
		this.atomicWrites.push(normalize(path));
	}

	snapshot(): Record<string, string> {
		return Object.fromEntries(
			[...this.files.entries()].sort(([left], [right]) =>
				left.localeCompare(right),
			),
		);
	}
}
