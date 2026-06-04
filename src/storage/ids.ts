import { createHash } from "node:crypto";
import { basename, normalize } from "node:path";

const PROJECT_ID_PREFIX_CHARS = 28;
const UUID_SUFFIX_PATTERN = /-[a-f0-9]{8}$/;

export function createProjectId(projectRoot: string): string {
	const displayName =
		compactIdPart(basename(normalize(projectRoot)), PROJECT_ID_PREFIX_CHARS) ||
		"project";
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

export function sanitizePathIdPart(value: string): string {
	return sanitizeIdPart(value)
		.replace(/\./g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export function compactIdPart(value: string, maxLength: number): string {
	const sanitized = sanitizePathIdPart(value);
	if (sanitized.length <= maxLength) return sanitized;

	const uuidSuffix = sanitized.match(UUID_SUFFIX_PATTERN)?.[0];
	if (uuidSuffix && uuidSuffix.length < maxLength) {
		const prefix = trimIdPart(
			sanitized.slice(0, maxLength - uuidSuffix.length),
		);
		return `${prefix}${uuidSuffix}`;
	}

	const cut = sanitized.slice(0, maxLength);
	const lastHyphen = cut.lastIndexOf("-");
	if (lastHyphen >= 8) {
		return trimIdPart(cut.slice(0, lastHyphen));
	}
	return trimIdPart(cut);
}

function trimIdPart(value: string): string {
	return value.replace(/-+$/g, "") || "id";
}
