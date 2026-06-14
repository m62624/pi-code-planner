import { randomUUID } from "node:crypto";
import { compactIdPart, sanitizePathIdPart } from "../storage/ids";
import type { ProjectRecord } from "../storage/schema";

export interface PlannerCreateCommandArgs {
	request?: string;
}

export interface PlannerImproveCommandArgs {
	request?: string;
	compatibilityMode: "additive" | "breaking";
}

const MAX_GENERATED_PLAN_TITLE_LENGTH = 80;
const MAX_GENERATED_PLAN_TITLE_WORDS = 6;
const MAX_PLAN_DESCRIPTION_LENGTH = 90;
const PLAN_PREFIX_CHARS = 24;
const REQUESTED_PLAN_ID_CHARS = 40;
const PLAN_UUID_SUFFIX_LENGTH = 8;
const MAX_IDEA_TOKENS = 4;

const GENERIC_PROJECT_NAMES = new Set(["app", "project", "repo", "repository"]);
const GENERIC_PLAN_TOKENS = new Set([
	"planner",
	"controlled",
	"workflow",
	"work",
	"task",
	"tasks",
	"project",
	"repo",
	"repository",
	"crate",
	"library",
	"package",
	"code",
	"local",
	"model",
	"llm",
	"agent",
	"tdd",
	"big",
	"long",
	"many",
	"mega",
	"large",
	"small",
	"new",
	"todo",
	"for",
	"the",
	"and",
	"with",
	"from",
	"into",
	"this",
	"that",
]);

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

export function parsePlannerImproveCommandArgs(
	args: string,
): PlannerImproveCommandArgs | null {
	const tokens = tokenizeCommandArgs(args);
	let compatibilityMode: "additive" | "breaking" = "additive";
	let explicitMode: "additive" | "breaking" | null = null;
	const requestParts: string[] = [];

	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === "--additive") {
			if (explicitMode === "breaking") return null;
			explicitMode = "additive";
			compatibilityMode = "additive";
			continue;
		}
		if (token === "--breaking") {
			if (explicitMode === "additive") return null;
			explicitMode = "breaking";
			compatibilityMode = "breaking";
			continue;
		}
		if (token === "--compat") {
			const value = tokens[index + 1];
			if (value !== "additive" && value !== "breaking") return null;
			if (explicitMode && explicitMode !== value) return null;
			explicitMode = value;
			compatibilityMode = value;
			index += 1;
			continue;
		}
		if (token.startsWith("--compat=")) {
			const value = token.slice("--compat=".length);
			if (value !== "additive" && value !== "breaking") return null;
			if (explicitMode && explicitMode !== value) return null;
			explicitMode = value;
			compatibilityMode = value;
			continue;
		}
		if (token.startsWith("--")) return null;
		requestParts.push(token);
	}

	const request = requestParts.join(" ").trim();
	return {
		compatibilityMode,
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
	const requestTokens = tokenizeId(request);
	const projectTokens = meaningfulProjectTokens(projectDisplayName);
	const ideaTokens = meaningfulIdeaTokens(requestTokens, projectTokens);
	const joined = dedupeAdjacentIdTokens(
		[...projectTokens, ...ideaTokens].join("-"),
	);
	const fallback = dedupeAdjacentIdTokens(
		requestTokens.filter((token) => !GENERIC_PLAN_TOKENS.has(token)).join("-"),
	);
	return compactIdPart(joined || fallback || "plan", PLAN_PREFIX_CHARS);
}

function dedupeAdjacentIdTokens(value: string): string {
	const tokens = value.split("-").filter(Boolean);
	const deduped: string[] = [];
	for (const token of tokens) {
		if (deduped.at(-1) !== token) deduped.push(token);
	}
	return deduped.join("-");
}

function tokenizeId(value: string): string[] {
	return sanitizePathIdPart(value)
		.replace(/_/g, "-")
		.split("-")
		.filter(Boolean);
}

function meaningfulProjectTokens(projectDisplayName: string): string[] {
	const tokens = tokenizeId(projectDisplayName);
	if (
		tokens.length === 0 ||
		tokens.every((token) => GENERIC_PROJECT_NAMES.has(token))
	) {
		return [];
	}
	return tokens.filter((token) => token.length > 1).slice(0, 3);
}

function meaningfulIdeaTokens(
	requestTokens: readonly string[],
	projectTokens: readonly string[],
): string[] {
	const projectTokenSet = new Set(projectTokens);
	const idea: string[] = [];
	for (const token of requestTokens) {
		if (token.length <= 2 && !/^\d+$/.test(token)) continue;
		if (GENERIC_PLAN_TOKENS.has(token)) continue;
		if (projectTokenSet.has(token)) continue;
		if (
			[...projectTokenSet].some(
				(projectToken) =>
					projectToken.length >= 4 && token.startsWith(projectToken),
			)
		) {
			continue;
		}
		if (idea.at(-1) === token) continue;
		idea.push(token);
		if (idea.length >= MAX_IDEA_TOKENS) break;
	}
	return idea;
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
