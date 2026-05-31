import { sanitizeIdPart } from "../storage/ids";
import type { ProjectRecord } from "../storage/schema";

export interface PlannerCreateCommandArgs {
	planId?: string;
	request: string;
}

export function parsePlannerCreateCommandArgs(
	args: string,
): PlannerCreateCommandArgs | null {
	const tokens = tokenizeCommandArgs(args);
	if (tokens.length === 0) {
		return null;
	}

	let planId: string | undefined;
	const requestParts: string[] = [];
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === "--id") {
			const value = tokens[index + 1];
			if (!value || value.startsWith("--")) {
				return null;
			}
			planId = value;
			index += 1;
			continue;
		}
		if (token.startsWith("--id=")) {
			const value = token.slice("--id=".length);
			if (!value) {
				return null;
			}
			planId = value;
			continue;
		}
		requestParts.push(token);
	}

	const request = requestParts.join(" ").trim();
	if (request.length === 0) return null;
	return planId ? { planId, request } : { request };
}

export function resolvePlannerPlanId(input: {
	requestedPlanId?: string;
	request: string;
	project: ProjectRecord;
}): string {
	const requested = input.requestedPlanId
		? sanitizeIdPart(input.requestedPlanId)
		: "";
	if (input.requestedPlanId && requested.length === 0) {
		throw new TypeError(`Invalid planner id: ${input.requestedPlanId}`);
	}
	if (requested.length > 0) {
		return requested;
	}

	const base = sanitizeIdPart(input.request) || "plan";
	const existing = new Set(input.project.plans.map((plan) => plan.planId));
	if (!existing.has(base)) {
		return base;
	}

	for (let suffix = 2; suffix < 10_000; suffix += 1) {
		const candidate = `${base}-${suffix}`;
		if (!existing.has(candidate)) {
			return candidate;
		}
	}

	throw new Error(
		`Unable to allocate unique planner id for request: ${input.request}`,
	);
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
