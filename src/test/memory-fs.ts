import { dirname, normalize } from "node:path";
import type { PlannerFs } from "../settings/fs";

export class MemoryFs implements PlannerFs {
	private files = new Map<string, string>();
	private dirs = new Set<string>(["/"]);

	exists(path: string): boolean {
		const normalized = this.normalize(path);
		return this.files.has(normalized) || this.dirs.has(normalized);
	}

	mkdirp(path: string): void {
		const normalized = this.normalize(path);
		const parts = normalized.split("/").filter(Boolean);
		let current = normalized.startsWith("/") ? "/" : "";
		for (const part of parts) {
			current =
				current === "/" || current === ""
					? `${current}${part}`
					: `${current}/${part}`;
			this.dirs.add(current);
		}
	}

	readFile(path: string): string {
		const normalized = this.normalize(path);
		const value = this.files.get(normalized);
		if (value === undefined) {
			throw new Error(`File not found: ${normalized}`);
		}
		return value;
	}

	writeFile(path: string, content: string): void {
		const normalized = this.normalize(path);
		this.mkdirp(dirname(normalized));
		this.files.set(normalized, content);
	}

	rename(from: string, to: string): void {
		const normalizedFrom = this.normalize(from);
		const normalizedTo = this.normalize(to);
		const value = this.files.get(normalizedFrom);
		if (value === undefined) {
			throw new Error(`File not found: ${normalizedFrom}`);
		}
		this.mkdirp(dirname(normalizedTo));
		this.files.set(normalizedTo, value);
		this.files.delete(normalizedFrom);
	}

	listFiles(): string[] {
		return [...this.files.keys()].sort();
	}

	setFile(path: string, content: string): void {
		this.writeFile(path, content);
	}

	private normalize(path: string): string {
		return normalize(path).replace(/\/+$/, "") || "/";
	}
}
