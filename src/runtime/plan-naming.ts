import { randomUUID } from "node:crypto";
import { compactIdPart, sanitizePathIdPart } from "../storage/ids";
import type { ProjectRecord } from "../storage/schema";

export interface PlannerCreateCommandArgs {
	request?: string;
}

const MAX_GENERATED_PLAN_TITLE_LENGTH = 80;
const MAX_GENERATED_PLAN_TITLE_WORDS = 6;
const MAX_PLAN_DESCRIPTION_LENGTH = 90;
const PLAN_PREFIX_CHARS = 24;
const REQUESTED_PLAN_ID_CHARS = 40;
const PLAN_UUID_SUFFIX_LENGTH = 8;

export function parsePlannerCreateCommandArgs(
	args: string,
): PlannerCreateCommandArgs | null {
	const tokens = tokenizeCommandArgs(args);
	if (tokens.length === 0) {
		return {};
	}

	const requestParts: string[] = [];
	for (const token of tokens) {
		if (token.startsWith("--")) return null;
		requestParts.push(token);
	}

	const request = requestParts.join(" ").trim();
	return {
		...(request.length > 0 ? { request } : {}),
	};
}

export function resolvePlannerPlanId(input: {
	requestedPlanId?: string;
	request: string;
	project: ProjectRecord;
}): string {
	const requested = input.requestedPlanId
		? compactIdPart(input.requestedPlanId, REQUESTED_PLAN_ID_CHARS)
		: "";
	if (input.requestedPlanId && requested.length === 0) {
		throw new TypeError(`Invalid planner id: ${input.requestedPlanId}`);
	}
	const existing = new Set(input.project.plans.map((plan) => plan.planId));

	if (requested.length > 0) {
		if (!existing.has(requested)) {
			return requested;
		}
		return createUniqueIdWithUuid(
			compactIdPart(requested, PLAN_PREFIX_CHARS),
			existing,
		);
	}

	const prefix = generatePlanPrefix(input.request, input.project.displayName);
	return createUniqueIdWithUuid(prefix, existing);
}

function generatePlanPrefix(
	request: string,
	projectDisplayName: string,
): string {
	const requestId = sanitizePathIdPart(request);
	const projectId = sanitizePathIdPart(projectDisplayName);
	const withoutProjectPrefix =
		projectId && requestId.startsWith(`${projectId}-`)
			? requestId.slice(projectId.length + 1)
			: requestId;
	const deduped = dedupeAdjacentIdTokens(withoutProjectPrefix);
	return compactIdPart(deduped || requestId || "plan", PLAN_PREFIX_CHARS);
}

function dedupeAdjacentIdTokens(value: string): string {
	const tokens = value.split("-").filter(Boolean);
	const deduped: string[] = [];
	for (const token of tokens) {
		if (deduped.at(-1) !== token) deduped.push(token);
	}
	return deduped.join("-");
}

function createUniqueIdWithUuid(prefix: string, existing: Set<string>): string {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const suffix = randomUUID().slice(0, PLAN_UUID_SUFFIX_LENGTH);
		const candidate = `${prefix}-${suffix}`;
		if (!existing.has(candidate)) return candidate;
	}
	throw new Error(`Unable to allocate unique planner id for prefix: ${prefix}`);
}

export function createPlannerPlanTitle(request: string): string {
	const firstLine =
		request
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find(Boolean) ?? "Planner task";
	const words = firstLine.split(/\s+/).slice(0, MAX_GENERATED_PLAN_TITLE_WORDS);
	const compact = words.join(" ");
	return validatePlannerPlanTitle(
		compact.length <= MAX_GENERATED_PLAN_TITLE_LENGTH
			? compact
			: `${compact.slice(0, MAX_GENERATED_PLAN_TITLE_LENGTH - 3).trimEnd()}...`,
	);
}

export function createPlannerPlanDescription(request: string): string {
	const normalized = request.trim().replace(/\s+/g, " ");
	return validatePlannerPlanDescription(normalized);
}

export function validatePlannerPlanDescription(description: string): string {
	const normalized = description.trim().replace(/\s+/g, " ");
	if (!normalized) {
		throw new TypeError("description must be a non-empty string.");
	}
	if (normalized.length <= MAX_PLAN_DESCRIPTION_LENGTH) return normalized;
	return `${normalized.slice(0, MAX_PLAN_DESCRIPTION_LENGTH - 3).trimEnd()}...`;
}

export function validatePlannerPlanTitle(title: string): string {
	const normalized = title.trim().replace(/\s+/g, " ");
	if (!normalized) throw new TypeError("title must be a non-empty string.");
	if (normalized.length > MAX_GENERATED_PLAN_TITLE_LENGTH) {
		throw new TypeError(
			`title must be at most ${MAX_GENERATED_PLAN_TITLE_LENGTH} characters.`,
		);
	}
	return normalized;
}

function tokenizeCommandArgs(args: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | `"` | null = null;
	let escaping = false;

	for (const char of args.trim()) {
		if (escaping) {
			current += char;
			escaping = false;
			continue;
		}
		if (char === "\\") {
			escaping = true;
			continue;
		}
		if (quote) {
			if (char === quote) {
				quote = null;
			} else {
				current += char;
			}
			continue;
		}
		if (char === "'" || char === `"`) {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current.length > 0) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}

	if (escaping) {
		current += "\\";
	}
	if (current.length > 0) {
		tokens.push(current);
	}
	return tokens;
}
