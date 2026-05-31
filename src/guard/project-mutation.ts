import {
	basename,
	extname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import type { ProjectStoragePaths } from "../storage/paths";
import type { PlanStateRecord } from "../storage/schema";
import {
	checkRawGitAllowed,
	type GitWatcherDecision,
	type GitWatcherState,
	PLANNER_STATUS_TOOL_NAME,
} from "./git-watcher";

export type PlannerBuiltinToolCall =
	| { toolName: "write" | "edit"; path: string }
	| { toolName: "bash"; command: string };

export interface PlannerBuiltinGuardState extends GitWatcherState {
	projectPaths: Pick<ProjectStoragePaths, "plansDir"> | null;
	planState: Pick<
		PlanStateRecord,
		| "stage"
		| "step"
		| "broken"
		| "requiresCompact"
		| "requiresMemoryUpdate"
		| "requiresUserDecision"
		| "worktreePath"
	> | null;
}

export interface PlannerBuiltinGuardInput {
	cwd: string;
	tool: PlannerBuiltinToolCall;
	state: PlannerBuiltinGuardState;
}

export interface PlannerBuiltinGuardDecision {
	allow: boolean;
	reason: string | null;
}

const READ_ONLY_COMMANDS = new Set([
	"[",
	"basename",
	"cat",
	"cd",
	"command",
	"cut",
	"date",
	"dirname",
	"echo",
	"env",
	"fd",
	"file",
	"find",
	"grep",
	"head",
	"jq",
	"ls",
	"pwd",
	"readlink",
	"realpath",
	"rg",
	"sort",
	"stat",
	"tail",
	"test",
	"tree",
	"tr",
	"type",
	"uname",
	"uniq",
	"wc",
	"which",
]);

const CHECK_COMMANDS = new Set(["pytest", "vitest"]);

export function checkPlannerBuiltinToolAllowed(
	input: PlannerBuiltinGuardInput,
): PlannerBuiltinGuardDecision {
	if (!input.state.active) {
		return allow();
	}

	if (input.tool.toolName === "bash") {
		return checkPlannerBashAllowed(input.tool.command, input.state);
	}

	const target = resolveToolPath(input.cwd, input.tool.path);
	if (isPlannerWritableArtifactPath(target, input.state)) {
		return allowsPlannerArtifactWrite(input.state)
			? allow()
			: blockProjectMutation(input.state, input.tool.toolName);
	}

	return isActiveWorktreePath(target, input.state) &&
		allowsProjectMutation(input.state)
		? allow()
		: blockProjectMutation(input.state, input.tool.toolName);
}

export function isReadOnlyShellCommand(command: string): boolean {
	if (hasUnsafeShellSyntax(command)) {
		return false;
	}

	const segments = splitShellLikeSegments(command);
	return (
		segments.length > 0 &&
		segments.every((segment) => isReadOnlyShellSegment(segment))
	);
}

export function isFinalizeCheckCommand(command: string): boolean {
	if (hasUnsafeShellSyntax(command)) {
		return false;
	}

	const segments = splitShellLikeSegments(command);
	return (
		segments.length > 0 &&
		segments.every((segment) => {
			return isReadOnlyShellSegment(segment) || isCheckShellSegment(segment);
		})
	);
}

function checkPlannerBashAllowed(
	command: string,
	state: PlannerBuiltinGuardState,
): PlannerBuiltinGuardDecision {
	const gitDecision = checkRawGitAllowed({ command, state });
	if (!gitDecision.allow) {
		return gitDecision;
	}

	if (isReadOnlyShellCommand(command)) {
		return allow();
	}

	if (
		!hasBlockingRuntimeGate(state) &&
		state.planState?.stage === "execution" &&
		!state.planState.step.startsWith("compact_")
	) {
		return allow();
	}

	if (
		!hasBlockingRuntimeGate(state) &&
		state.planState?.stage === "finalize" &&
		isFinalizeCheckCommand(command)
	) {
		return allow();
	}

	return blockProjectMutation(state, "bash");
}

function allowsProjectMutation(state: PlannerBuiltinGuardState): boolean {
	return (
		!hasBlockingRuntimeGate(state) &&
		state.planState?.stage === "execution" &&
		!state.planState.step.startsWith("compact_")
	);
}

function allowsPlannerArtifactWrite(state: PlannerBuiltinGuardState): boolean {
	return (
		state.planState !== null &&
		!state.planState.requiresCompact &&
		!state.planState.requiresMemoryUpdate &&
		!state.planState.requiresUserDecision &&
		(!state.planState.broken || state.planState.stage === "recovery") &&
		!state.planState.step.startsWith("compact_")
	);
}

function hasBlockingRuntimeGate(state: PlannerBuiltinGuardState): boolean {
	return (
		state.planState === null ||
		state.planState.broken ||
		state.planState.requiresCompact ||
		state.planState.requiresMemoryUpdate ||
		state.planState.requiresUserDecision
	);
}

function isPlannerWritableArtifactPath(
	target: string,
	state: PlannerBuiltinGuardState,
): boolean {
	if (state.projectPaths === null || state.activePlanId === null) {
		return false;
	}
	const activePlanDir = join(state.projectPaths.plansDir, state.activePlanId);
	if (!isPathInside(activePlanDir, target)) {
		return false;
	}
	if (extname(target) === ".md") {
		return true;
	}
	const parts = relative(activePlanDir, target).split(sep);
	return (
		(parts.length === 3 && parts[0] === "tasks" && parts[2] === "task.json") ||
		(parts.length === 5 &&
			parts[0] === "tasks" &&
			parts[2] === "experiments" &&
			parts[4] === "experiment.json")
	);
}

function isActiveWorktreePath(
	target: string,
	state: PlannerBuiltinGuardState,
): boolean {
	return (
		state.planState?.worktreePath !== null &&
		state.planState?.worktreePath !== undefined &&
		isPathInside(state.planState.worktreePath, target)
	);
}

function isPathInside(root: string, target: string): boolean {
	const path = relative(resolve(root), target);
	return (
		path === "" ||
		(path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
	);
}

function resolveToolPath(cwd: string, path: string): string {
	return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

function isReadOnlyShellSegment(segment: string): boolean {
	const executable = shellSegmentExecutable(segment);
	if (!executable || !READ_ONLY_COMMANDS.has(executable)) {
		return false;
	}
	if (
		executable === "find" &&
		/\s-(?:delete|exec|execdir|ok|okdir|fls|fprint|fprintf)\b/.test(segment)
	) {
		return false;
	}
	return true;
}

function isCheckShellSegment(segment: string): boolean {
	const tokens = shellSegmentTokens(segment);
	const executable = tokens[0];
	if (!executable) {
		return false;
	}
	if (CHECK_COMMANDS.has(executable)) {
		return true;
	}
	const command = tokens[1];
	switch (executable) {
		case "npm":
		case "pnpm":
		case "yarn":
		case "bun":
			return (
				command === "test" ||
				command === "check" ||
				command === "lint" ||
				command === "build" ||
				(command === "run" && isSafeCheckScript(tokens[2]))
			);
		case "npx":
			return ["biome", "eslint", "tsc", "vitest"].includes(command ?? "");
		case "cargo":
			return ["build", "check", "clippy", "fmt", "test"].includes(
				command ?? "",
			);
		case "go":
			return ["build", "test", "vet"].includes(command ?? "");
		case "deno":
			return ["check", "lint", "test"].includes(command ?? "");
		case "dotnet":
			return ["build", "test"].includes(command ?? "");
		case "gradle":
		case "gradlew":
		case "mvn":
			return ["check", "test", "verify"].includes(command ?? "");
		case "python":
		case "python3":
		case "uv":
			return command === "-m" && tokens[2] === "pytest";
		default:
			return false;
	}
}

function isSafeCheckScript(script: string | undefined): boolean {
	return (
		script !== undefined &&
		/^(?:build|check|lint|test|typecheck)(?::[A-Za-z0-9_-]+)*$/.test(script)
	);
}

function shellSegmentExecutable(segment: string): string | null {
	return shellSegmentTokens(segment)[0] ?? null;
}

function shellSegmentTokens(segment: string): string[] {
	const tokens = segment.match(/[^\s]+/g) ?? [];
	let changed = true;
	while (changed) {
		changed = false;
		while (tokens[0] && /^[A-Za-z_][A-Za-z0-9_]*=\S+$/.test(tokens[0])) {
			tokens.shift();
			changed = true;
		}
		if (tokens[0] === "command") {
			tokens.shift();
			changed = true;
		}
		if (tokens[0] === "env") {
			tokens.shift();
			while (
				tokens[0] &&
				(tokens[0].startsWith("-") ||
					/^[A-Za-z_][A-Za-z0-9_]*=\S+$/.test(tokens[0]))
			) {
				tokens.shift();
			}
			changed = true;
		}
	}
	if (tokens[0]) {
		tokens[0] = basename(tokens[0]);
	}
	return tokens;
}

function splitShellLikeSegments(command: string): string[] {
	return command
		.split(/&&|\|\||[;|\n()]/g)
		.map((segment) => segment.trim())
		.filter(Boolean);
}

function hasUnsafeShellSyntax(command: string): boolean {
	return (
		/(^|[^<])>{1,2}|&>/.test(command) ||
		/<<-?/.test(command) ||
		/\$\(|`|<\(|>\(/.test(command) ||
		/(^|\s)tee(?:\s|$)/.test(command)
	);
}

function blockProjectMutation(
	state: PlannerBuiltinGuardState,
	toolName: PlannerBuiltinToolCall["toolName"],
): PlannerBuiltinGuardDecision {
	const position = state.planState
		? `${state.planState.stage}/${state.planState.step}`
		: "(planner state unavailable)";
	return {
		allow: false,
		reason: [
			`Built-in Pi ${toolName} is blocked while pi-code-planner controls project mutations.`,
			`Active planner plan: ${state.activePlanId ?? "(unknown)"}.`,
			`Current planner position: ${position}.`,
			"",
			"Project mutation is allowed only during execution steps with open runtime gates.",
			"Planner artifacts outside the project worktree remain writable through write/edit when the current runtime gate is open.",
			`Call ${PLANNER_STATUS_TOOL_NAME} and follow the exact current instruction before continuing.`,
		].join("\n"),
	};
}

function allow(): GitWatcherDecision {
	return { allow: true, reason: null };
}
