import type { BranchNamingSettings } from "../settings/schema";

export interface BranchNamingValues {
	planId: string;
	workItemId?: string;
	attemptId?: string;
}

type BranchNamingValueKey = keyof BranchNamingValues;

export interface RenderedBranchNames {
	plan: string;
	child: string;
	experiment: string;
}

const REQUIRED_PLACEHOLDERS = {
	plan: ["planId"],
	child: ["planId", "workItemId"],
	experiment: ["planId", "workItemId", "attemptId"],
} as const;

function slug(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function renderTemplate(template: string, values: BranchNamingValues): string {
	return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key: string) => {
		const value = values[key as BranchNamingValueKey];
		if (!value) {
			throw new Error(`Missing branch naming value: ${key}`);
		}
		return slug(value);
	});
}

function placeholders(template: string): Set<string> {
	return new Set(
		[...template.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((match) => match[1]),
	);
}

function validateRequiredPlaceholders(
	name: keyof BranchNamingSettings,
	template: string,
): void {
	const actual = placeholders(template);
	for (const required of REQUIRED_PLACEHOLDERS[name]) {
		if (!actual.has(required)) {
			throw new Error(`Branch naming template ${name} missing {${required}}`);
		}
	}
}

function validateRenderedBranch(name: string): void {
	if (name.length === 0) {
		throw new Error("Branch name cannot be empty");
	}
	if (
		name.startsWith("/") ||
		name.endsWith("/") ||
		name.includes("//") ||
		name.includes("..") ||
		name.endsWith(".") ||
		name.includes("@{") ||
		/[~^:?*[\\\s]/.test(name)
	) {
		throw new Error(`Invalid branch name: ${name}`);
	}
	for (const segment of name.split("/")) {
		if (
			segment.length === 0 ||
			segment.startsWith(".") ||
			segment.endsWith(".lock")
		) {
			throw new Error(`Invalid branch name: ${name}`);
		}
	}
}

function assertNoPrefixConflict(names: RenderedBranchNames): void {
	const entries = Object.entries(names);
	for (const [leftKind, leftName] of entries) {
		for (const [rightKind, rightName] of entries) {
			if (leftKind === rightKind) continue;
			if (rightName.startsWith(`${leftName}/`)) {
				throw new Error(
					`Branch naming conflict: ${leftKind} (${leftName}) is a prefix of ${rightKind} (${rightName})`,
				);
			}
		}
	}
}

export function renderBranchNames(
	settings: BranchNamingSettings,
	values: BranchNamingValues,
): RenderedBranchNames {
	const rendered = {
		plan: renderTemplate(settings.plan, values),
		child: renderTemplate(settings.child, values),
		experiment: renderTemplate(settings.experiment, values),
	};

	for (const name of Object.values(rendered)) {
		validateRenderedBranch(name);
	}
	assertNoPrefixConflict(rendered);
	return rendered;
}

export function validateBranchNamingSettings(
	settings: BranchNamingSettings,
): void {
	validateRequiredPlaceholders("plan", settings.plan);
	validateRequiredPlaceholders("child", settings.child);
	validateRequiredPlaceholders("experiment", settings.experiment);
	renderBranchNames(settings, {
		planId: "plan",
		workItemId: "work",
		attemptId: "attempt",
	});
}
