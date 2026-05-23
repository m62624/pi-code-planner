import { createHash } from "node:crypto";
import { basename, normalize } from "node:path";

export function createProjectId(projectRoot: string): string {
	const displayName =
		sanitizeIdPart(basename(normalize(projectRoot))) || "project";
	const hash = createHash("sha256")
		.update(normalize(projectRoot))
		.digest("hex")
		.slice(0, 8);
	return `${displayName}-${hash}`;
}

export function sanitizeIdPart(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
}
