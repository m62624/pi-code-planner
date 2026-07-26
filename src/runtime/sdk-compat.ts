// SDK compatibility self-check.
//
// The planner's peer dependency on `@earendil-works/pi-coding-agent` is pinned to
// `*`, so the extension runs against whatever Pi build the user has — which may be
// far ahead of the version it was tested against. A hard version gate is the wrong
// tool: a bumped Pi is usually still compatible, and a same-version Pi can still
// change behavior. So instead of gating on the version number, this module probes
// the *contract* — the concrete dynamic `pi.*` / `ctx.*` surfaces the extension
// actually calls — and reports what is missing, WITHOUT blocking anything.
//
// Scope, deliberately narrow:
//   • We probe only the runtime-resolved surfaces (`pi`, the command `ctx`). Named
//     module imports (`getAgentDir`, `SessionManager`, `VERSION`, …) are NOT probed:
//     if the SDK drops one, ESM linking fails and the extension never loads — that
//     is a hard load error, not something a soft warning could reach.
//   • We probe API *shape* (method/object presence & type), never populated values.
//     `ctx.model` is intentionally excluded: it is legitimately `undefined` before a
//     model is selected, so its absence is a runtime state, not an incompatibility.
//   • Event names (e.g. `turn_end`) are not probeable — `pi.on` accepts any string
//     and silently ignores unknown events; there is no registry to query. A silently
//     missing event degrades to the reactive/backstop path, not a crash.
//
// The report is surfaced locally via `ctx.ui.notify` only; nothing is ever sent
// anywhere. Every function here is pure and deterministic (no I/O), so the whole
// check is unit-testable by passing plain fake `pi`/`ctx` objects.

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { PLANNER_KNOWN_GOOD_PI_VERSIONS } from "../constants";

export type SdkSurfaceSeverity = "critical" | "optional";
export type SdkSurfaceKind = "function" | "object" | "string";
export type SdkSurfaceTarget = "api" | "ctx";
export type SdkSurfaceStatus = "missing" | "wrong_type";

// The probed paths are plain strings at runtime, but they are typed against the
// real SDK interfaces so the list cannot silently drift from them. If Pi renames
// or drops one of these members, `tsc` fails here — which is the point: the SDK
// watch PR then goes red for the true reason instead of only at the call sites,
// and this list (the thing the runtime advisory reads) can never point at a
// member that no longer exists. Nesting is spelled out rather than derived
// recursively: `ui` is the only nested root, and a generic dotted-path type would
// also admit function internals like `on.apply`.
type ApiSurfacePath = keyof ExtensionAPI & string;
type CtxSurfacePath =
	| (keyof ExtensionCommandContext & string)
	| `ui.${keyof ExtensionCommandContext["ui"] & string}`;

interface SdkSurfaceSpecBase {
	/** Expected shape of the resolved value. */
	kind: SdkSurfaceKind;
	/** Critical surfaces break core flows; optional ones only degrade a feature. */
	severity: SdkSurfaceSeverity;
	/** What stops working when this surface is absent (shown to the user). */
	feature: string;
}

/**
 * One dynamic SDK surface the extension depends on at runtime. `target` picks the
 * runtime root (`pi` or the command `ctx`) and constrains `path` to members that
 * root actually declares.
 */
export type SdkSurfaceSpec = SdkSurfaceSpecBase &
	(
		| { target: "api"; path: ApiSurfacePath }
		| { target: "ctx"; path: CtxSurfacePath }
	);

export type SdkSurfaceFinding = SdkSurfaceSpec & {
	status: SdkSurfaceStatus;
	/** `typeof` of the resolved value, or "absent" when nothing was found. */
	actualType: string;
};

export interface SdkVersionAdvisory {
	version: string | null;
	/** True when the version matches a range the planner was tested against. */
	known: boolean;
}

export interface SdkCompatReport {
	sdkVersion: string | null;
	version: SdkVersionAdvisory;
	/** The tested major.minor prefixes this report was evaluated against. */
	testedRange: readonly string[];
	/** True when there are no critical findings (extension core is usable). */
	ok: boolean;
	criticalCount: number;
	optionalCount: number;
	findings: SdkSurfaceFinding[];
}

// The contract: every dynamic surface the extension calls, with the feature that
// degrades if it disappears. Keep this in sync with real `pi.*` / `ctx.*` usage.
export const SDK_REQUIRED_SURFACES: readonly SdkSurfaceSpec[] = [
	// --- pi (ExtensionAPI) ---
	{
		target: "api",
		path: "on",
		kind: "function",
		severity: "critical",
		feature: "lifecycle events (compaction, turn_end, idle watchdog)",
	},
	{
		target: "api",
		path: "registerCommand",
		kind: "function",
		severity: "critical",
		feature: "the /planner-* slash commands",
	},
	{
		target: "api",
		path: "registerTool",
		kind: "function",
		severity: "critical",
		feature: "planner LLM tools",
	},
	{
		target: "api",
		path: "sendUserMessage",
		kind: "function",
		severity: "critical",
		feature: "idle-wake and post-compaction recovery messages",
	},
	{
		target: "api",
		path: "sendMessage",
		kind: "function",
		severity: "optional",
		feature: "helper/skills custom messages",
	},
	// --- ctx (ExtensionCommandContext) ---
	{
		target: "ctx",
		path: "getContextUsage",
		kind: "function",
		severity: "critical",
		feature: "smart context budget / compaction timing",
	},
	{
		target: "ctx",
		path: "compact",
		kind: "function",
		severity: "critical",
		feature: "controlled and proactive compaction",
	},
	{
		target: "ctx",
		path: "ui",
		kind: "object",
		severity: "critical",
		feature: "all user-facing dialogs and notifications",
	},
	{
		target: "ctx",
		path: "ui.notify",
		kind: "function",
		severity: "critical",
		feature: "warnings and toasts",
	},
	{
		target: "ctx",
		path: "ui.editor",
		kind: "function",
		severity: "critical",
		feature: "the planner request editor",
	},
	{
		target: "ctx",
		path: "ui.confirm",
		kind: "function",
		severity: "optional",
		feature: "the git-init confirmation prompt",
	},
	{
		target: "ctx",
		path: "sessionManager",
		kind: "object",
		severity: "critical",
		feature: "worktree session binding",
	},
	{
		target: "ctx",
		path: "cwd",
		kind: "string",
		severity: "critical",
		feature: "project resolution",
	},
	{
		target: "ctx",
		path: "waitForIdle",
		kind: "function",
		severity: "critical",
		feature: "command entry synchronization",
	},
	{
		target: "ctx",
		path: "switchSession",
		kind: "function",
		severity: "optional",
		feature: "auto-switch into the worktree session",
	},
];

function resolveSurfaceValue(root: unknown, path: string): unknown {
	let current: unknown = root;
	for (const segment of path.split(".")) {
		if (
			current === null ||
			(typeof current !== "object" && typeof current !== "function")
		) {
			return undefined;
		}
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function describeType(value: unknown): string {
	if (value === null) return "null";
	if (value === undefined) return "absent";
	return typeof value;
}

function surfaceSatisfied(kind: SdkSurfaceKind, value: unknown): boolean {
	switch (kind) {
		case "function":
			return typeof value === "function";
		case "object":
			return typeof value === "object" && value !== null;
		case "string":
			return typeof value === "string";
	}
}

/**
 * Decide whether a Pi version falls inside a tested range. `knownGood` holds
 * major.minor prefixes (e.g. "0.80"); a version matches when it equals a prefix
 * or begins with `<prefix>.`. A null/empty version is treated as unknown.
 */
export function evaluatePiVersionAdvisory(
	version: string | null,
	knownGood: readonly string[],
): SdkVersionAdvisory {
	if (version === null || version.length === 0) {
		return { version: version === "" ? null : version, known: false };
	}
	const known = knownGood.some(
		(prefix) => version === prefix || version.startsWith(`${prefix}.`),
	);
	return { version, known };
}

/**
 * Probe the runtime `pi`/`ctx` objects against {@link SDK_REQUIRED_SURFACES} and
 * summarize the result. Pure: reflection over the passed objects only.
 */
export function buildSdkCompatReport(input: {
	sdkVersion: string | null;
	api: unknown;
	ctx: unknown;
	/**
	 * Tested major.minor prefixes. Defaults to the shipped constant; passed
	 * explicitly by tests so their fixtures do not silently change meaning when
	 * the SDK watcher rewrites {@link PLANNER_KNOWN_GOOD_PI_VERSIONS}.
	 */
	knownGood?: readonly string[];
}): SdkCompatReport {
	const knownGood = input.knownGood ?? PLANNER_KNOWN_GOOD_PI_VERSIONS;
	const findings: SdkSurfaceFinding[] = [];
	for (const spec of SDK_REQUIRED_SURFACES) {
		const root = spec.target === "api" ? input.api : input.ctx;
		const value = resolveSurfaceValue(root, spec.path);
		if (surfaceSatisfied(spec.kind, value)) continue;
		findings.push({
			...spec,
			status: value === undefined ? "missing" : "wrong_type",
			actualType: describeType(value),
		});
	}
	const criticalCount = findings.filter(
		(finding) => finding.severity === "critical",
	).length;
	return {
		sdkVersion: input.sdkVersion,
		version: evaluatePiVersionAdvisory(input.sdkVersion, knownGood),
		testedRange: knownGood,
		ok: criticalCount === 0,
		criticalCount,
		optionalCount: findings.length - criticalCount,
		findings,
	};
}

function testedRangeLabel(report: SdkCompatReport): string {
	return report.testedRange.map((prefix) => `${prefix}.x`).join(", ");
}

/**
 * Render the report as a single local notification, or null when there is nothing
 * worth surfacing (all surfaces intact AND the version is known-good). Never sends
 * anything anywhere — the caller passes the message to `ctx.ui.notify`.
 */
export function formatSdkCompatWarning(
	report: SdkCompatReport,
): { message: string; level: "warning" | "info" } | null {
	const versionLabel = report.sdkVersion ?? "unknown";
	if (report.findings.length > 0) {
		const lines = report.findings.map((finding) => {
			const marker = finding.severity === "critical" ? "✖" : "○";
			const root = finding.target === "api" ? "pi" : "ctx";
			const detail =
				finding.status === "missing"
					? "missing"
					: `unexpected type (${finding.actualType})`;
			return `${marker} ${root}.${finding.path} — ${detail}; affects ${finding.feature}`;
		});
		const head =
			report.criticalCount > 0
				? `Planner may not work correctly with this Pi build (v${versionLabel}). ${report.criticalCount} required SDK surface(s) unavailable:`
				: `Planner: ${report.optionalCount} optional SDK surface(s) unavailable on this Pi build (v${versionLabel}); those features are degraded:`;
		const tail = report.version.known
			? ""
			: `\nThis Pi version is outside the tested range (${testedRangeLabel(report)}), which is the likely cause. This is a local check — nothing was sent anywhere.`;
		return { message: `${head}\n${lines.join("\n")}${tail}`, level: "warning" };
	}
	if (!report.version.known) {
		return {
			message: `Pi v${versionLabel} has not been validated with this planner build (tested: ${testedRangeLabel(report)}), but all required SDK surfaces are intact. If something behaves oddly, this version gap is the first thing to check.`,
			level: "info",
		};
	}
	return null;
}

/**
 * Stable signature of a report, used to avoid re-notifying the identical situation
 * within one session. Sorted so surface order never changes the signature.
 */
export function sdkCompatReportSignature(report: SdkCompatReport): string {
	const parts = report.findings
		.map((finding) => `${finding.target}.${finding.path}:${finding.status}`)
		.sort();
	return `${report.sdkVersion ?? "?"}|${report.version.known ? "k" : "u"}|${parts.join(",")}`;
}
