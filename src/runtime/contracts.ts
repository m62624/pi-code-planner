import { createHash } from "node:crypto";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	normalize,
	relative,
	resolve,
} from "node:path";
import type { GitRunner } from "../git/runner";
import { loadEffectivePlannerSettings } from "../settings/manager";
import type { PlannerContractsSettings } from "../settings/schema";
import type { PlannerFs } from "../storage/fs";
import { readJsonIfExists, writeJson } from "../storage/json";
import {
	createTaskStoragePaths,
	type PlanStoragePaths,
	type ProjectStoragePaths,
} from "../storage/paths";
import type {
	PlannerContractChainRecord,
	PlannerContractCheckAction,
	PlannerContractPendingUpsert,
	PlannerContractSummaryRecord,
	PlannerContractsState,
	PlannerContractTouchedFile,
	PlanStateRecord,
} from "../storage/schema";
import { updatePlanState } from "../storage/state-store";
import { appendPlannerSection } from "./artifact-utils";
import {
	checkPlannerOrchestratorToolAllowed,
	runPlannerOrchestrator,
} from "./orchestrator";

export const PLANNER_CONTRACT_TOOL_NAMES = [
	"planner_contract_scan",
	"planner_contract_route",
	"planner_contract_read",
	"planner_contract_check",
	"planner_contract_upsert",
	"planner_contract_decide",
] as const;

export type PlannerContractToolName =
	(typeof PLANNER_CONTRACT_TOOL_NAMES)[number];

export const PLANNER_CONTRACT_START =
	"<!-- pi-code-planner:contracts:start -->";
export const PLANNER_CONTRACT_END = "<!-- pi-code-planner:contracts:end -->";

const MANAGED_TITLE = "## Planner Contracts";
const SECTION_HEADINGS = [
	"Purpose",
	"Parent",
	"Child Index",
	"Stable Contracts",
	"Read First",
	"Do Not Touch Unless",
	"Domain Details",
] as const;

export const PLANNER_CONTEXT_BASENAMES = [
	"AGENTS.md",
	"AGENTS.MD",
	"CLAUDE.md",
	"CLAUDE.MD",
	"GEMINI.md",
	"GEMINI.MD",
	"CURSOR.md",
	"CURSOR.MD",
	".cursorrules",
	"WARP.md",
	"WARP.MD",
	"AIDER.md",
	"AIDER.MD",
	"COPILOT.md",
	"COPILOT.MD",
] as const;

export const PLANNER_WRITABLE_CONTRACT_BASENAMES = [
	"AGENTS.md",
	"AGENTS.MD",
] as const;
export const PLANNER_READONLY_CONTEXT_BASENAMES =
	PLANNER_CONTEXT_BASENAMES.filter(
		(name) =>
			!(PLANNER_WRITABLE_CONTRACT_BASENAMES as readonly string[]).includes(
				name,
			),
	);

const IGNORED_DIR_NAMES = new Set([
	".git",
	".pi",
	"node_modules",
	"dist",
	"coverage",
	".turbo",
	".next",
	"target",
	"vendor",
]);

type ContractSectionHeading = (typeof SECTION_HEADINGS)[number];

export interface PlannerContract {
	path: string;
	purpose: string;
	parent: string | null;
	childIndex: PlannerContractChildIndexEntry[];
	stableContracts: string[];
	readFirst: string[];
	doNotTouchUnless: string[];
	domainDetails: string[];
}

export interface PlannerContractChildIndexEntry {
	path: string;
	description: string;
}

export interface PlannerContractParseDiagnostic {
	severity: "warning" | "error";
	code: string;
	message: string;
	path?: string;
}

export interface PlannerContractParseResult {
	path: string;
	hasManagedBlock: boolean;
	contract: PlannerContract | null;
	diagnostics: PlannerContractParseDiagnostic[];
}

export interface PlannerContractScanResult {
	scannedDirectories: string[];
	discoveredPaths: string[];
	complete: boolean;
	queueLength: number;
}

export interface PlannerContractsManifest {
	version: 1;
	touchedFiles: PlannerContractTouchedFile[];
}

export interface PlannerContractToolResult {
	status: "applied" | "blocked";
	toolName: PlannerContractToolName;
	text: string;
	details: unknown;
}

export async function executePlannerContractTool(input: {
	fs: PlannerFs;
	git: GitRunner;
	projectPaths: ProjectStoragePaths;
	toolName: PlannerContractToolName;
	params: unknown;
}): Promise<PlannerContractToolResult> {
	const orchestrator = await runPlannerOrchestrator(input);
	if (orchestrator.preflight.context.status !== "ready") {
		return blocked(input.toolName, orchestrator.preflight.context.reason);
	}
	const policy = checkPlannerOrchestratorToolAllowed({
		orchestrator,
		toolName: input.toolName,
	});
	if (!policy.allow) {
		return blocked(
			input.toolName,
			policy.reason ??
				`Planner contract tool ${input.toolName} is blocked by runtime policy.`,
		);
	}

	const settings = await loadEffectivePlannerSettings({
		fs: input.fs,
		projectPaths: input.projectPaths,
	});
	if (!settings.effective.contracts.enabled) {
		return blocked(input.toolName, "Planner local contracts are disabled.");
	}

	try {
		switch (input.toolName) {
			case "planner_contract_scan":
				return await contractScan(input, settings.effective.contracts);
			case "planner_contract_route":
				return await contractRoute(input, settings.effective.contracts);
			case "planner_contract_read":
				return await contractRead(input, settings.effective.contracts);
			case "planner_contract_check":
				return await contractCheck(input);
			case "planner_contract_upsert":
				return await contractUpsert(input);
			case "planner_contract_decide":
				return await contractDecide(input);
		}
	} catch (error) {
		return blocked(input.toolName, errorMessage(error));
	}
}

async function contractScan(
	input: {
		fs: PlannerFs;
		git: GitRunner;
		projectPaths: ProjectStoragePaths;
		toolName: PlannerContractToolName;
		params: unknown;
	},
	settings: PlannerContractsSettings,
): Promise<PlannerContractToolResult> {
	const orchestrator = await runPlannerOrchestrator({
		fs: input.fs,
		git: input.git,
		projectPaths: input.projectPaths,
	});
	if (orchestrator.preflight.context.status !== "ready") {
		return blocked(input.toolName, orchestrator.preflight.context.reason);
	}
	const { planPaths, state } = orchestrator.preflight.context;
	const params = asObject(input.params);
	const batchSize =
		positiveIntegerOrUndefined(params.batchSize, "batchSize") ??
		settings.scanBatchSize;
	const root = requireWorktreePath(state);
	const currentQueue = state.contracts.scanComplete
		? [root]
		: state.contracts.scanQueue.length > 0
			? state.contracts.scanQueue
			: [root];
	const result = await scanContractFiles({
		fs: input.fs,
		root,
		queue: currentQueue,
		alreadyDiscovered: state.contracts.scanComplete
			? []
			: state.contracts.discoveredPaths,
		batchSize,
	});
	await updatePlanState(input.fs, planPaths, (current) => ({
		...current,
		contracts: {
			...current.contracts,
			scanComplete: result.complete,
			scanQueue: result.queue,
			discoveredPaths: result.discoveredPaths,
			diagnostics: uniqueStrings([
				...current.contracts.diagnostics,
				...result.diagnostics,
			]).slice(-20),
		},
	}));
	return applied(input.toolName, formatScanResult(result), {
		...result,
		queueLength: result.queue.length,
	});
}

async function contractRoute(
	input: {
		fs: PlannerFs;
		git: GitRunner;
		projectPaths: ProjectStoragePaths;
		toolName: PlannerContractToolName;
		params: unknown;
	},
	settings: PlannerContractsSettings,
): Promise<PlannerContractToolResult> {
	const orchestrator = await runPlannerOrchestrator({
		fs: input.fs,
		git: input.git,
		projectPaths: input.projectPaths,
	});
	if (orchestrator.preflight.context.status !== "ready") {
		return blocked(input.toolName, orchestrator.preflight.context.reason);
	}
	const { planPaths, state } = orchestrator.preflight.context;
	const params = asObject(input.params);
	const targetPaths = stringArray(params.targetPaths, "targetPaths", true);
	const declaredScope = stringArray(
		params.declaredScope,
		"declaredScope",
		true,
	);
	const reason = optionalString(params.reason) ?? "planner contract route";
	const root = requireWorktreePath(state);
	const targets = targetPaths.length > 0 ? targetPaths : declaredScope;
	if (targets.length === 0) {
		throw new TypeError(
			"targetPaths or declaredScope must include at least one path or domain hint.",
		);
	}
	const discovered = await ensureKnownContractPaths({
		fs: input.fs,
		root,
		state,
	});
	const chains = targets.map((target) =>
		buildContractChainForTarget({
			root,
			targetPath: target,
			discoveredPaths: discovered,
			reason,
		}),
	);
	const limitedChains = chains.slice(0, settings.maxActiveChains);
	await updatePlanState(input.fs, planPaths, (current) => ({
		...current,
		contracts: {
			...current.contracts,
			activeChains: limitedChains,
		},
	}));
	return applied(input.toolName, formatRouteResult(limitedChains), {
		chains: limitedChains,
	});
}

async function contractRead(
	input: {
		fs: PlannerFs;
		git: GitRunner;
		projectPaths: ProjectStoragePaths;
		toolName: PlannerContractToolName;
		params: unknown;
	},
	settings: PlannerContractsSettings,
): Promise<PlannerContractToolResult> {
	const orchestrator = await runPlannerOrchestrator({
		fs: input.fs,
		git: input.git,
		projectPaths: input.projectPaths,
	});
	if (orchestrator.preflight.context.status !== "ready") {
		return blocked(input.toolName, orchestrator.preflight.context.reason);
	}
	const { planPaths, state } = orchestrator.preflight.context;
	const params = asObject(input.params);
	const root = requireWorktreePath(state);
	const path = resolveContractPath({
		root,
		path:
			optionalString(params.path) ?? state.contracts.pendingRead?.path ?? "",
	});
	const cursor =
		positiveIntegerOrUndefined(params.cursor, "cursor") ??
		state.contracts.pendingRead?.cursor ??
		0;
	const reason =
		optionalString(params.reason) ??
		state.contracts.pendingRead?.reason ??
		"read contract file";
	const content = await input.fs.readText(path);
	const chunk = content.slice(cursor, cursor + settings.readChunkChars);
	const nextCursor = cursor + chunk.length;
	const complete = nextCursor >= content.length;
	const parsed = complete ? parsePlannerContractMarkdown(content, path) : null;
	const diagnostics = parsed ? parsed.diagnostics.map(formatDiagnostic) : [];
	await updatePlanState(input.fs, planPaths, (current) => ({
		...current,
		contracts: {
			...current.contracts,
			pendingRead: complete
				? null
				: {
						path,
						cursor: nextCursor,
						reason,
					},
			summaries: parsed
				? upsertContractSummary(current.contracts.summaries, parsed)
				: current.contracts.summaries,
			diagnostics: uniqueStrings([
				...current.contracts.diagnostics,
				...diagnostics,
			]).slice(-20),
		},
	}));
	return applied(
		input.toolName,
		[
			`Contract file: ${path}`,
			`Cursor: ${cursor}`,
			`Next cursor: ${complete ? "(complete)" : String(nextCursor)}`,
			complete
				? "Read complete. Use this contract before source reads in this domain."
				: "Read incomplete. Call planner_contract_read again with the same path or omit path to continue pendingRead.",
			"",
			"```markdown",
			chunk.trimEnd(),
			"```",
			...(diagnostics.length
				? ["", "Diagnostics:", ...diagnostics.map((entry) => `- ${entry}`)]
				: []),
		].join("\n"),
		{ path, cursor, nextCursor: complete ? null : nextCursor, complete },
	);
}

async function contractCheck(input: {
	fs: PlannerFs;
	git: GitRunner;
	projectPaths: ProjectStoragePaths;
	toolName: PlannerContractToolName;
	params: unknown;
}): Promise<PlannerContractToolResult> {
	const orchestrator = await runPlannerOrchestrator({
		fs: input.fs,
		git: input.git,
		projectPaths: input.projectPaths,
	});
	if (orchestrator.preflight.context.status !== "ready") {
		return blocked(input.toolName, orchestrator.preflight.context.reason);
	}
	const { planPaths, state } = orchestrator.preflight.context;
	const params = asObject(input.params);
	const taskId = optionalString(params.taskId) ?? state.activeTaskId;
	const action = enumValue(
		params.action,
		["no_update", "upsert_existing", "create_new"] as const,
		"action",
	);
	const changedFiles = stringArray(params.changedFiles, "changedFiles", true);
	const outcomeSummary = requiredString(params, "outcomeSummary");
	const domainImpact = requiredString(params, "domainImpact");
	const evidence = stringArray(params.evidence, "evidence", true);
	const recommendedPath = optionalString(params.recommendedPath);
	const initialContractReason = initialWritableContractRequired({
		state,
		action,
		changedFiles,
		evidence,
	});
	if (initialContractReason) {
		throw new Error(initialContractReason);
	}
	const pendingUpsert: PlannerContractPendingUpsert | null =
		action === "no_update"
			? null
			: {
					path: resolveContractPath({
						root: requireWorktreePath(state),
						path:
							recommendedPath ??
							defaultContractPathForChangedFiles({
								root: requireWorktreePath(state),
								changedFiles,
							}),
						writableOnly: true,
					}),
					reason: outcomeSummary,
					taskId,
				};
	await appendContractCheckToTask({
		fs: input.fs,
		planPaths,
		taskId,
		action,
		outcomeSummary,
		domainImpact,
		changedFiles,
		evidence,
		recommendedPath: pendingUpsert?.path ?? null,
	});
	const checkedAt = Date.now();
	await updatePlanState(input.fs, planPaths, (current) => ({
		...current,
		contracts: {
			...current.contracts,
			pendingCheckTaskId: pendingUpsert ? taskId : null,
			pendingUpsert,
			lastCheck: {
				taskId,
				action,
				path: pendingUpsert?.path ?? null,
				summary: outcomeSummary,
				checkedAt,
			},
		},
	}));
	return applied(
		input.toolName,
		[
			`Planner contract check recorded for task: ${taskId ?? "(none)"}.`,
			`Action: ${action}`,
			pendingUpsert
				? `Contract update required: call planner_contract_upsert for ${pendingUpsert.path}.`
				: "No contract update is required for this task.",
			"Call planner_status before choosing the next planner action.",
		].join("\n"),
		{ taskId, action, pendingUpsert },
	);
}

async function contractUpsert(input: {
	fs: PlannerFs;
	git: GitRunner;
	projectPaths: ProjectStoragePaths;
	toolName: PlannerContractToolName;
	params: unknown;
}): Promise<PlannerContractToolResult> {
	const orchestrator = await runPlannerOrchestrator({
		fs: input.fs,
		git: input.git,
		projectPaths: input.projectPaths,
	});
	if (orchestrator.preflight.context.status !== "ready") {
		return blocked(input.toolName, orchestrator.preflight.context.reason);
	}
	const { planPaths, state } = orchestrator.preflight.context;
	const params = asObject(input.params);
	const root = requireWorktreePath(state);
	const path = resolveContractPath({
		root,
		path:
			optionalString(params.path) ?? state.contracts.pendingUpsert?.path ?? "",
		writableOnly: true,
	});
	const contract: PlannerContract = {
		path,
		purpose: requiredString(params, "purpose"),
		parent:
			optionalString(params.parent) ?? defaultParentForContract(root, path),
		childIndex: childIndexArray(params.childIndex),
		stableContracts: stringArray(params.stableContracts, "stableContracts"),
		readFirst: stringArray(params.readFirst, "readFirst", true),
		doNotTouchUnless: stringArray(
			params.doNotTouchUnless,
			"doNotTouchUnless",
			true,
		),
		domainDetails: stringArray(params.domainDetails, "domainDetails", true),
	};
	const existing = (await input.fs.exists(path))
		? await input.fs.readText(path)
		: null;
	const next = upsertPlannerContractBlock({
		existingContent: existing ?? "",
		contract,
		root,
	});
	const validation = parsePlannerContractMarkdown(next, path, root);
	const errors = validation.diagnostics.filter(
		(diagnostic) => diagnostic.severity === "error",
	);
	if (errors.length > 0) {
		throw new Error(
			`Contract upsert validation failed: ${errors.map(formatDiagnostic).join("; ")}`,
		);
	}
	await ensureContractBaseline({
		fs: input.fs,
		planPaths,
		state,
		path,
		existingContent: existing,
	});
	await input.fs.writeTextAtomic(path, next);
	const currentSha256 = sha256(next);
	const updatedState = await updatePlanState(
		input.fs,
		planPaths,
		(current) => ({
			...current,
			contracts: {
				...current.contracts,
				dirty: true,
				finalDecision: current.contracts.finalDecision,
				discoveredPaths: uniqueStrings([
					...current.contracts.discoveredPaths,
					path,
				]),
				summaries: upsertContractSummary(
					current.contracts.summaries,
					validation,
				),
				pendingCheckTaskId:
					current.contracts.pendingUpsert?.path === path
						? null
						: current.contracts.pendingCheckTaskId,
				pendingUpsert:
					current.contracts.pendingUpsert?.path === path
						? null
						: current.contracts.pendingUpsert,
				touchedFiles: upsertTouchedFile(current.contracts.touchedFiles, {
					path,
					existedBeforePlan: existing !== null,
					baselineSha256: existing === null ? null : sha256(existing),
					baselinePath: baselinePathForContract(planPaths, path),
					currentSha256,
					changeKind: existing === null ? "created" : "updated",
				}),
				diagnostics: uniqueStrings([
					...current.contracts.diagnostics,
					...validation.diagnostics.map(formatDiagnostic),
				]).slice(-20),
			},
		}),
	);
	await writeContractsManifest(input.fs, planPaths, updatedState.contracts);
	return applied(
		input.toolName,
		[
			`Planner contract written: ${path}`,
			existing === null
				? "Created new AGENTS.md contract file."
				: "Updated existing AGENTS.md managed block and preserved non-planner content.",
			"Commit this change through planner_git_commit when the current step requires a clean worktree.",
		].join("\n"),
		{ path, diagnostics: validation.diagnostics },
	);
}

async function contractDecide(input: {
	fs: PlannerFs;
	git: GitRunner;
	projectPaths: ProjectStoragePaths;
	toolName: PlannerContractToolName;
	params: unknown;
}): Promise<PlannerContractToolResult> {
	const orchestrator = await runPlannerOrchestrator({
		fs: input.fs,
		git: input.git,
		projectPaths: input.projectPaths,
	});
	if (orchestrator.preflight.context.status !== "ready") {
		return blocked(input.toolName, orchestrator.preflight.context.reason);
	}
	const { planPaths, state } = orchestrator.preflight.context;
	const decision = enumValue(
		asObject(input.params).decision,
		["keep", "remove"] as const,
		"decision",
	);
	if (decision === "remove") {
		await restoreContractTouches(input.fs, planPaths, state.contracts);
	}
	const nextState = await updatePlanState(input.fs, planPaths, (current) => ({
		...current,
		contracts: {
			...current.contracts,
			finalDecision: decision,
			dirty: decision === "keep" ? current.contracts.dirty : false,
			touchedFiles: decision === "keep" ? current.contracts.touchedFiles : [],
			pendingUpsert: null,
			pendingCheckTaskId: null,
		},
	}));
	await writeContractsManifest(input.fs, planPaths, nextState.contracts);
	return applied(
		input.toolName,
		decision === "keep"
			? "Planner AGENTS.md contract updates will be kept in the accepted result."
			: "Planner-created AGENTS.md files were removed and preexisting AGENTS.md files were restored from the plan baseline.",
		{ decision },
	);
}

export async function applyPlannerContractFinishPolicy(input: {
	fs: PlannerFs;
	planPaths: PlanStoragePaths;
	state: PlanStateRecord;
	decision?: "keep" | "remove";
}): Promise<{ decision: "keep" | "remove" | "none"; message: string }> {
	const contracts = input.state.contracts;
	if (
		!contracts.enabled ||
		!contracts.dirty ||
		contracts.touchedFiles.length === 0
	) {
		return { decision: "none", message: "No planner contract changes." };
	}
	const decision =
		input.decision ??
		(contracts.finalPolicy === "remove"
			? "remove"
			: contracts.finalPolicy === "keep"
				? "keep"
				: contracts.finalDecision === "keep" ||
						contracts.finalDecision === "remove"
					? contracts.finalDecision
					: null);
	if (!decision) {
		throw new Error(
			"Planner contract changes need an explicit keep/remove decision before finish.",
		);
	}
	if (decision === "remove") {
		await restoreContractTouches(input.fs, input.planPaths, contracts);
	}
	const nextState = await updatePlanState(
		input.fs,
		input.planPaths,
		(current) => ({
			...current,
			contracts: {
				...current.contracts,
				finalDecision: decision,
				dirty: decision === "keep" ? current.contracts.dirty : false,
				touchedFiles: decision === "keep" ? current.contracts.touchedFiles : [],
				pendingUpsert: null,
				pendingCheckTaskId: null,
			},
		}),
	);
	await writeContractsManifest(input.fs, input.planPaths, nextState.contracts);
	return {
		decision,
		message:
			decision === "keep"
				? "Planner AGENTS.md contract updates kept."
				: "Planner AGENTS.md contract updates removed/restored before export.",
	};
}

export function hasPendingContractFinishDecision(
	state: PlanStateRecord,
): boolean {
	return (
		state.contracts.enabled &&
		state.contracts.dirty &&
		state.contracts.touchedFiles.length > 0 &&
		state.contracts.finalPolicy === "ask" &&
		state.contracts.finalDecision === "pending"
	);
}

export function validateContractCheckCompleted(
	state: PlanStateRecord,
): string | null {
	if (!state.contracts.enabled) {
		return null;
	}
	if (!state.activeTaskId) {
		return "Contract check requires an active task.";
	}
	if (state.contracts.pendingUpsert) {
		return `Contract update is still pending for ${state.contracts.pendingUpsert.path}. Call planner_contract_upsert or rerun planner_contract_check with no_update evidence.`;
	}
	if (state.contracts.pendingCheckTaskId) {
		return `Contract check is incomplete for task ${state.contracts.pendingCheckTaskId}.`;
	}
	return state.contracts.lastCheck?.taskId === state.activeTaskId
		? null
		: "Call planner_contract_check for the active task before refactor_task.";
}

export function validateDiscoveryContractRouting(input: {
	state: PlanStateRecord;
	settingsEnabled: boolean;
}): string | null {
	const contracts = input.state.contracts;
	if (!input.settingsEnabled || !contracts.enabled) {
		return null;
	}
	if (!contracts.scanComplete) {
		return "Planner contract scan is incomplete. Continue planner_contract_scan until scanComplete=true before finishing discovery/scan_project_structure.";
	}
	if (contracts.discoveredPaths.length === 0) {
		return null;
	}
	if (contracts.activeChains.length === 0) {
		return "Planner contract scan found AGENTS.md/context files. Call planner_contract_route for the current goal/scope before finishing discovery/scan_project_structure.";
	}
	for (const chain of contracts.activeChains) {
		const nearest = chain.chain.at(-1);
		if (!nearest) {
			continue;
		}
		const read = contracts.summaries.some(
			(summary) => summary.path === nearest,
		);
		if (!read) {
			return `Planner contract route selected ${nearest}, but it has not been read. Call planner_contract_read for the nearest relevant contract before finishing discovery/scan_project_structure.`;
		}
	}
	return null;
}

export async function readPlannerContractsManifest(
	fs: PlannerFs,
	planPaths: PlanStoragePaths,
): Promise<PlannerContractsManifest | null> {
	return await readJsonIfExists<PlannerContractsManifest>(
		fs,
		planPaths.contractsManifestJson,
	);
}

export function formatPlannerContractsStatus(input: {
	state: PlanStateRecord;
	settings: PlannerContractsSettings;
}): string[] {
	const contracts = input.state.contracts;
	if (!input.settings.enabled || !contracts.enabled) {
		return ["- enabled: false"];
	}
	const lines = [
		`- enabled: true`,
		`- scanComplete: ${String(contracts.scanComplete)}`,
		`- discoveredPaths: ${contracts.discoveredPaths.length}`,
		`- dirty: ${String(contracts.dirty)}`,
		`- finalPolicy: ${contracts.finalPolicy}`,
		`- finalDecision: ${contracts.finalDecision}`,
		`- pendingRead: ${contracts.pendingRead ? `${contracts.pendingRead.path}@${contracts.pendingRead.cursor}` : "(none)"}`,
		`- pendingCheckTaskId: ${contracts.pendingCheckTaskId ?? "(none)"}`,
		`- pendingUpsert: ${contracts.pendingUpsert?.path ?? "(none)"}`,
		`- touchedFiles: ${contracts.touchedFiles.length}`,
	];
	if (contracts.activeChains.length > 0) {
		lines.push("- activeChains:");
		for (const chain of contracts.activeChains) {
			lines.push(
				`  - target: ${chain.targetPath}`,
				`    chain: ${chain.chain.length ? chain.chain.join(" -> ") : "(none)"}`,
			);
		}
	}
	if (contracts.activeChains.length > 0) {
		lines.push("- activeContractSummaries:");
		lines.push(
			...buildActiveContractSummaryLines({
				chains: contracts.activeChains,
				summaries: contracts.summaries,
				settings: input.settings,
			}),
		);
	}
	if (contracts.pendingRead) {
		lines.push(
			"- guidance: Continue pending contract read with planner_contract_read before source reads in that domain.",
		);
	} else if (
		input.state.stage === "execution" &&
		input.state.step === "contract_check"
	) {
		lines.push(
			"- guidance: Implementation is green; call planner_contract_check before refactor_task.",
		);
	} else if (contracts.pendingUpsert) {
		lines.push(
			`- guidance: Contract update required; call planner_contract_upsert for ${contracts.pendingUpsert.path}.`,
		);
	} else if (
		input.state.stage === "discovery" &&
		input.state.step === "scan_project_structure" &&
		contracts.scanComplete &&
		contracts.discoveredPaths.length > 0 &&
		contracts.activeChains.length === 0
	) {
		lines.push(
			"- guidance: Contract files were found. Call planner_contract_route before source reads or before finishing discovery.",
		);
	} else if (
		input.state.stage === "discovery" &&
		input.state.step === "scan_project_structure" &&
		contracts.activeChains.some(
			(chain) =>
				chain.chain.length > 0 &&
				!contracts.summaries.some(
					(summary) => summary.path === chain.chain.at(-1),
				),
		)
	) {
		lines.push(
			"- guidance: A relevant contract chain is selected. Call planner_contract_read for the nearest unread contract before finishing discovery.",
		);
	} else if (!contracts.scanComplete) {
		lines.push(
			"- guidance: During discovery, call planner_contract_scan before broad source reads.",
		);
	}
	for (const diagnostic of contracts.diagnostics.slice(-5)) {
		lines.push(`- diagnostic: ${diagnostic}`);
	}
	return lines;
}

function buildActiveContractSummaryLines(input: {
	chains: readonly PlannerContractChainRecord[];
	summaries: readonly PlannerContractSummaryRecord[];
	settings: PlannerContractsSettings;
}): string[] {
	const lines: string[] = [];
	let remaining = input.settings.statusCharBudget;
	const seen = new Set<string>();
	const summaryByPath = new Map(
		input.summaries.map((summary) => [summary.path, summary]),
	);
	for (const chain of input.chains) {
		for (let index = 0; index < chain.chain.length; index += 1) {
			const path = chain.chain[index];
			if (seen.has(path) || remaining <= 0) continue;
			seen.add(path);
			const level =
				index === 0
					? "root"
					: index === chain.chain.length - 1
						? "nearest"
						: "ancestor";
			const budget = Math.min(remaining, input.settings.levelBudgets[level]);
			const stored = summaryByPath.get(path);
			if (!stored) {
				const message = `  - ${level}: ${path} (summary not loaded; call planner_contract_read)`;
				remaining -= message.length;
				lines.push(message);
				continue;
			}
			const summary = summarizeStoredContract(stored, level, budget);
			remaining -= summary.length;
			lines.push(
				`  - ${level}: ${path}`,
				...summary.split("\n").map((line) => `    ${line}`),
			);
		}
	}
	return lines.length > 0 ? lines : ["  - (none)"];
}

function summarizeStoredContract(
	summary: PlannerContractSummaryRecord,
	level: "root" | "ancestor" | "nearest",
	budget: number,
): string {
	const parts =
		level === "root"
			? [
					`purpose: ${summary.purpose}`,
					`children: ${summary.childIndex.join("; ") || "(none)"}`,
				]
			: level === "ancestor"
				? [
						`purpose: ${summary.purpose}`,
						`stable: ${summary.stableContracts.join("; ") || "(none)"}`,
						`readFirst: ${summary.readFirst.join("; ") || "(none)"}`,
					]
				: [
						`purpose: ${summary.purpose}`,
						`stable: ${summary.stableContracts.join("; ") || "(none)"}`,
						`readFirst: ${summary.readFirst.join("; ") || "(none)"}`,
						`doNotTouchUnless: ${summary.doNotTouchUnless.join("; ") || "(none)"}`,
						`domainDetails: ${summary.domainDetails.join("; ") || "(none)"}`,
					];
	const diagnostics = summary.diagnostics.length
		? [`diagnostics: ${summary.diagnostics.join("; ")}`]
		: [];
	return truncateForBudget([...parts, ...diagnostics].join("\n"), budget);
}

function truncateForBudget(value: string, budget: number): string {
	if (value.length <= budget) {
		return value;
	}
	return `${value.slice(0, Math.max(0, budget - 24)).trimEnd()}\n    ... truncated by contract budget`;
}

export function parsePlannerContractMarkdown(
	content: string,
	path: string,
	root?: string,
): PlannerContractParseResult {
	const diagnostics: PlannerContractParseDiagnostic[] = [];
	const starts = countOccurrences(content, PLANNER_CONTRACT_START);
	const ends = countOccurrences(content, PLANNER_CONTRACT_END);
	if (starts === 0 && ends === 0) {
		const writable = isWritableContractPath(path);
		return {
			path,
			hasManagedBlock: false,
			contract: null,
			diagnostics: [
				{
					severity: "warning",
					code: "missing_managed_block",
					message: writable
						? `Writable AGENTS.md is missing the pi-code-planner managed block. Read existing text as user-authored guidance, then call planner_contract_upsert if durable planner memory is needed. Required headings: ${SECTION_HEADINGS.join(", ")}.`
						: `Read-only context import has no pi-code-planner managed block. Read it as user-authored guidance only; do not edit this file through planner_contract_upsert. If the guidance should become durable planner routing memory, create/update the nearest AGENTS.md with required headings: ${SECTION_HEADINGS.join(", ")}.`,
					path,
				},
			],
		};
	}
	if (starts !== 1 || ends !== 1) {
		diagnostics.push({
			severity: "error",
			code: "invalid_marker_count",
			message: `Expected exactly one pi-code-planner managed block delimited by ${PLANNER_CONTRACT_START} and ${PLANNER_CONTRACT_END}, found start=${starts}, end=${ends}. Remove duplicate/incomplete blocks or rewrite with planner_contract_upsert.`,
			path,
		});
	}
	const start = content.indexOf(PLANNER_CONTRACT_START);
	const end = content.indexOf(PLANNER_CONTRACT_END);
	if (start < 0 || end < start) {
		return { path, hasManagedBlock: true, contract: null, diagnostics };
	}
	const block = content
		.slice(start + PLANNER_CONTRACT_START.length, end)
		.replace(/\r\n/g, "\n")
		.trim();
	const lines = block.split("\n");
	if (lines[0]?.trim() !== MANAGED_TITLE) {
		diagnostics.push({
			severity: "error",
			code: "missing_title",
			message: `Managed block must start with ${MANAGED_TITLE} immediately after the start marker.`,
			path,
		});
	}
	const sections = new Map<ContractSectionHeading, string[]>();
	let current: ContractSectionHeading | null = null;
	for (const rawLine of lines.slice(1)) {
		const line = rawLine.trimEnd();
		const heading = /^###\s+(.+)$/.exec(line)?.[1]?.trim();
		if (heading) {
			if (!isKnownSectionHeading(heading)) {
				diagnostics.push({
					severity: "error",
					code: "unknown_heading",
					message: `Unknown contract heading: ${heading}. Allowed headings are: ${SECTION_HEADINGS.map((item) => `### ${item}`).join(", ")}.`,
					path,
				});
				current = null;
				continue;
			}
			if (sections.has(heading)) {
				diagnostics.push({
					severity: "error",
					code: "duplicate_heading",
					message: `Duplicate contract heading: ${heading}.`,
					path,
				});
			}
			sections.set(heading, []);
			current = heading;
			continue;
		}
		if (current) {
			sections.get(current)?.push(line);
		}
	}
	for (const heading of SECTION_HEADINGS) {
		if (!sections.has(heading)) {
			diagnostics.push({
				severity: heading === "Domain Details" ? "warning" : "error",
				code: "missing_heading",
				message: `Missing contract heading: ${heading}. The managed block must include headings in this schema: ${SECTION_HEADINGS.map((item) => `### ${item}`).join(", ")}.`,
				path,
			});
		}
	}
	const contract: PlannerContract = {
		path,
		purpose: sectionText(sections.get("Purpose") ?? []),
		parent: parseParent(sections.get("Parent") ?? []),
		childIndex: parseChildIndex(sections.get("Child Index") ?? [], path),
		stableContracts: parseList(sections.get("Stable Contracts") ?? []),
		readFirst: parseList(sections.get("Read First") ?? []),
		doNotTouchUnless: parseList(sections.get("Do Not Touch Unless") ?? []),
		domainDetails: parseList(sections.get("Domain Details") ?? []),
	};
	diagnostics.push(...validateContractReferences(contract, root));
	return { path, hasManagedBlock: true, contract, diagnostics };
}

export function upsertPlannerContractBlock(input: {
	existingContent: string;
	contract: PlannerContract;
	root: string;
}): string {
	const block = formatPlannerContractBlock(input.contract);
	const existing = input.existingContent.replace(/\r\n/g, "\n");
	const start = existing.indexOf(PLANNER_CONTRACT_START);
	const end = existing.indexOf(PLANNER_CONTRACT_END);
	if (start >= 0 && end > start) {
		const before = existing.slice(0, start).trimEnd();
		const after = existing.slice(end + PLANNER_CONTRACT_END.length).trimStart();
		return [before, block, after]
			.filter((part) => part.length > 0)
			.join("\n\n")
			.concat("\n");
	}
	return [existing.trimEnd(), block]
		.filter((part) => part.length > 0)
		.join("\n\n")
		.concat("\n");
}

export function formatPlannerContractBlock(contract: PlannerContract): string {
	return [
		PLANNER_CONTRACT_START,
		MANAGED_TITLE,
		"",
		"### Purpose",
		contract.purpose.trim(),
		"",
		"### Parent",
		contract.parent ? `- \`${contract.parent}\`` : "- `(root)`",
		"",
		"### Child Index",
		...formatChildIndex(contract.childIndex),
		"",
		"### Stable Contracts",
		...formatList(contract.stableContracts),
		"",
		"### Read First",
		...formatList(contract.readFirst, "(none)"),
		"",
		"### Do Not Touch Unless",
		...formatList(contract.doNotTouchUnless, "(none)"),
		"",
		"### Domain Details",
		...formatList(contract.domainDetails, "(none)"),
		PLANNER_CONTRACT_END,
	].join("\n");
}

async function scanContractFiles(input: {
	fs: PlannerFs;
	root: string;
	queue: string[];
	alreadyDiscovered: string[];
	batchSize: number;
}): Promise<
	PlannerContractScanResult & { queue: string[]; diagnostics: string[] }
> {
	const queue = [...input.queue.map((path) => normalize(path))];
	const discovered = new Set(
		input.alreadyDiscovered.map((path) => normalize(path)),
	);
	const scannedDirectories: string[] = [];
	const diagnostics: string[] = [];
	let remaining = input.batchSize;
	while (queue.length > 0 && remaining > 0) {
		const dir = queue.shift();
		if (!dir || !isPathInside(input.root, dir)) {
			continue;
		}
		remaining -= 1;
		scannedDirectories.push(dir);
		for (const name of PLANNER_CONTEXT_BASENAMES) {
			const candidate = join(dir, name);
			if (await input.fs.exists(candidate)) {
				discovered.add(normalize(candidate));
			}
		}
		let entries: string[];
		try {
			entries = await input.fs.readdir(dir);
		} catch {
			continue;
		}
		for (const entry of entries.sort()) {
			if (
				IGNORED_DIR_NAMES.has(entry) ||
				(PLANNER_CONTEXT_BASENAMES as readonly string[]).includes(entry)
			) {
				continue;
			}
			const child = join(dir, entry);
			if (!(await input.fs.isDirectory(child))) {
				continue;
			}
			if (!isPathInside(input.root, child)) {
				diagnostics.push(`Skipped outside path during contract scan: ${child}`);
				continue;
			}
			queue.push(child);
		}
	}
	return {
		scannedDirectories,
		discoveredPaths: [...discovered].sort(),
		complete: queue.length === 0,
		queueLength: queue.length,
		queue,
		diagnostics,
	};
}

async function ensureKnownContractPaths(input: {
	fs: PlannerFs;
	root: string;
	state: PlanStateRecord;
}): Promise<string[]> {
	const discovered = new Set(input.state.contracts.discoveredPaths);
	for (const name of PLANNER_CONTEXT_BASENAMES) {
		const candidate = join(input.root, name);
		if (await input.fs.exists(candidate)) {
			discovered.add(normalize(candidate));
		}
	}
	return [...discovered].sort();
}

function buildContractChainForTarget(input: {
	root: string;
	targetPath: string;
	discoveredPaths: string[];
	reason: string;
}): PlannerContractChainRecord {
	const target = resolveTargetPath(input.root, input.targetPath);
	const targetDir = looksLikeFilePath(target) ? dirname(target) : target;
	const chain = input.discoveredPaths
		.filter((contractPath) => {
			const contractDir = dirname(contractPath);
			return (
				targetDir === contractDir || targetDir.startsWith(`${contractDir}/`)
			);
		})
		.sort((left, right) => left.length - right.length);
	return {
		targetPath: target,
		chain,
		reason: input.reason,
		updatedAt: Date.now(),
	};
}

function resolveContractPath(input: {
	root: string;
	path: string;
	writableOnly?: boolean;
}): string {
	if (!input.path.trim()) {
		throw new TypeError("Contract path must be provided.");
	}
	const path = normalize(
		isAbsolutePath(input.path) ? input.path : resolve(input.root, input.path),
	);
	if (!isPathInside(input.root, path)) {
		throw new TypeError(
			`Contract path must stay inside worktree: ${input.path}`,
		);
	}
	const allowed = input.writableOnly
		? PLANNER_WRITABLE_CONTRACT_BASENAMES
		: PLANNER_CONTEXT_BASENAMES;
	if (!(allowed as readonly string[]).includes(basename(path))) {
		throw new TypeError(
			input.writableOnly
				? "Managed contract updates may only write AGENTS.md or AGENTS.MD."
				: `Contract path must be one of: ${PLANNER_CONTEXT_BASENAMES.join(", ")}.`,
		);
	}
	return path;
}

function isWritableContractPath(path: string): boolean {
	return (PLANNER_WRITABLE_CONTRACT_BASENAMES as readonly string[]).includes(
		basename(path),
	);
}

function defaultContractPathForChangedFiles(input: {
	root: string;
	changedFiles: string[];
}): string {
	const first = input.changedFiles[0];
	if (!first) {
		return join(input.root, "AGENTS.md");
	}
	const target = resolveTargetPath(input.root, first);
	const dir = looksLikeFilePath(target) ? dirname(target) : target;
	return join(dir, "AGENTS.md");
}

export function initialWritableContractRequired(input: {
	state: PlanStateRecord;
	action: PlannerContractCheckAction;
	changedFiles: readonly string[];
	evidence: readonly string[];
}): string | null {
	if (input.action !== "no_update") {
		return null;
	}
	if (hasWritableContractMemory(input.state)) {
		return null;
	}
	const projectFiles = input.changedFiles.filter(
		isContractRelevantProjectChange,
	);
	if (projectFiles.length === 0) {
		return null;
	}
	const evidenceText = input.evidence.join("\n").toLowerCase();
	const missingAgentsUsedAsExcuse =
		evidenceText.includes("no agents.md") ||
		evidenceText.includes("no existing contracts") ||
		evidenceText.includes("no writable contract");
	return [
		"Cannot record planner_contract_check as no_update for project changes when no writable AGENTS.md contract exists yet.",
		`Project changed files: ${projectFiles.join(", ")}.`,
		missingAgentsUsedAsExcuse
			? "Absence of AGENTS.md is not evidence for no_update; it is evidence to create the initial root/domain contract."
			: "Create the initial meaningful root/domain AGENTS.md contract for future planner runs, or change the check action to create_new with a recommendedPath.",
		"Call planner_contract_check again with action=create_new, then call planner_contract_upsert.",
	].join("\n");
}

function hasWritableContractMemory(state: PlanStateRecord): boolean {
	return [
		...state.contracts.discoveredPaths,
		...state.contracts.touchedFiles.map((item) => item.path),
	].some((path) => isWritableContractPath(path));
}

function isContractRelevantProjectChange(path: string): boolean {
	const normalizedPath = path.replace(/\\/g, "/").toLowerCase();
	if (normalizedPath.endsWith("/agents.md") || normalizedPath === "agents.md") {
		return false;
	}
	if (
		normalizedPath.endsWith(".md") ||
		normalizedPath.endsWith(".mdx") ||
		normalizedPath.endsWith(".txt")
	) {
		return false;
	}
	return true;
}

function defaultParentForContract(root: string, path: string): string | null {
	const parentDir = dirname(dirname(path));
	if (
		!isPathInside(root, parentDir) ||
		normalize(parentDir) === normalize(dirname(path))
	) {
		return null;
	}
	return relative(dirname(path), join(parentDir, "AGENTS.md")) || "AGENTS.md";
}

async function appendContractCheckToTask(input: {
	fs: PlannerFs;
	planPaths: PlanStoragePaths;
	taskId: string | null;
	action: PlannerContractCheckAction;
	outcomeSummary: string;
	domainImpact: string;
	changedFiles: string[];
	evidence: string[];
	recommendedPath: string | null;
}): Promise<void> {
	if (!input.taskId) {
		return;
	}
	const paths = createTaskStoragePaths(input.planPaths, input.taskId);
	if (!(await input.fs.exists(paths.tddMd))) {
		return;
	}
	await appendPlannerSection(input.fs, paths.tddMd, {
		heading: "Contract Consistency Check",
		lines: [
			`- action: ${input.action}`,
			`- outcome: ${input.outcomeSummary}`,
			`- domain impact: ${input.domainImpact}`,
			`- recommended path: ${input.recommendedPath ?? "(none)"}`,
			"- changed files:",
			...formatIndentedList(input.changedFiles, "(none)"),
			"- evidence:",
			...formatIndentedList(input.evidence, "(none)"),
		],
	});
}

async function ensureContractBaseline(input: {
	fs: PlannerFs;
	planPaths: PlanStoragePaths;
	state: PlanStateRecord;
	path: string;
	existingContent: string | null;
}): Promise<void> {
	if (
		input.state.contracts.touchedFiles.some(
			(entry) => entry.path === input.path,
		)
	) {
		return;
	}
	await input.fs.mkdirp(input.planPaths.contractsBaselineDir);
	const baselinePath = baselinePathForContract(input.planPaths, input.path);
	if (input.existingContent !== null) {
		await input.fs.writeTextAtomic(baselinePath, input.existingContent);
	}
}

function baselinePathForContract(
	planPaths: PlanStoragePaths,
	path: string,
): string {
	return join(
		planPaths.contractsBaselineDir,
		`${createHash("sha256").update(path).digest("hex")}.md`,
	);
}

async function restoreContractTouches(
	fs: PlannerFs,
	planPaths: PlanStoragePaths,
	contracts: PlannerContractsState,
): Promise<void> {
	for (const touch of contracts.touchedFiles) {
		if (!touch.existedBeforePlan) {
			await fs.removeFile(touch.path);
			continue;
		}
		const baselinePath =
			touch.baselinePath ?? baselinePathForContract(planPaths, touch.path);
		if (!(await fs.exists(baselinePath))) {
			throw new Error(
				`Cannot restore contract file because baseline is missing: ${baselinePath}`,
			);
		}
		await fs.writeTextAtomic(touch.path, await fs.readText(baselinePath));
	}
}

async function writeContractsManifest(
	fs: PlannerFs,
	planPaths: PlanStoragePaths,
	contracts: PlannerContractsState,
): Promise<void> {
	await fs.mkdirp(planPaths.contractsDir);
	await writeJson<PlannerContractsManifest>(
		fs,
		planPaths.contractsManifestJson,
		{
			version: 1,
			touchedFiles: contracts.touchedFiles,
		},
	);
}

function upsertTouchedFile(
	current: readonly PlannerContractTouchedFile[],
	touched: PlannerContractTouchedFile,
): PlannerContractTouchedFile[] {
	const index = current.findIndex((entry) => entry.path === touched.path);
	if (index < 0) {
		return [...current, touched];
	}
	return current.map((entry, entryIndex) =>
		entryIndex === index
			? {
					...entry,
					currentSha256: touched.currentSha256,
					changeKind: touched.changeKind,
				}
			: entry,
	);
}

function upsertContractSummary(
	current: readonly PlannerContractSummaryRecord[],
	parsed: PlannerContractParseResult,
): PlannerContractSummaryRecord[] {
	const summary: PlannerContractSummaryRecord = parsed.contract
		? {
				path: parsed.path,
				purpose: parsed.contract.purpose,
				childIndex: parsed.contract.childIndex.map(
					(entry) => `${entry.path}: ${entry.description}`,
				),
				stableContracts: parsed.contract.stableContracts,
				readFirst: parsed.contract.readFirst,
				doNotTouchUnless: parsed.contract.doNotTouchUnless,
				domainDetails: parsed.contract.domainDetails,
				diagnostics: parsed.diagnostics.map(formatDiagnostic),
				updatedAt: Date.now(),
			}
		: {
				path: parsed.path,
				purpose: "(unparsed)",
				childIndex: [],
				stableContracts: [],
				readFirst: [],
				doNotTouchUnless: [],
				domainDetails: [],
				diagnostics: parsed.diagnostics.map(formatDiagnostic),
				updatedAt: Date.now(),
			};
	const index = current.findIndex((entry) => entry.path === parsed.path);
	if (index < 0) return [...current, summary];
	return current.map((entry, entryIndex) =>
		entryIndex === index ? summary : entry,
	);
}

function validateContractReferences(
	contract: PlannerContract,
	root: string | undefined,
): PlannerContractParseDiagnostic[] {
	const diagnostics: PlannerContractParseDiagnostic[] = [];
	if (!root) {
		return diagnostics;
	}
	const dir = dirname(contract.path);
	const isRootContract = normalize(dir) === normalize(root);
	if (isRootContract && contract.parent) {
		diagnostics.push({
			severity: "warning",
			code: "root_parent_present",
			message: "Root AGENTS.md normally uses `(root)` as parent.",
			path: contract.path,
		});
	}
	if (!isRootContract && !contract.parent) {
		diagnostics.push({
			severity: "error",
			code: "missing_parent",
			message: "Non-root AGENTS.md must include a parent backlink.",
			path: contract.path,
		});
	}
	if (contract.parent) {
		const parentPath = resolve(dir, contract.parent);
		if (!isPathInside(root, parentPath)) {
			diagnostics.push({
				severity: "error",
				code: "parent_outside_root",
				message: `Parent path leaves worktree: ${contract.parent}`,
				path: contract.path,
			});
		}
		if (normalize(parentPath) === normalize(contract.path)) {
			diagnostics.push({
				severity: "error",
				code: "parent_self_reference",
				message: "Parent must not reference the current contract file.",
				path: contract.path,
			});
		}
	}
	for (const child of contract.childIndex) {
		const childPath = resolve(dir, child.path);
		if (!isPathInside(root, childPath)) {
			diagnostics.push({
				severity: "error",
				code: "child_outside_root",
				message: `Child Index path leaves worktree: ${child.path}`,
				path: contract.path,
			});
		}
		if (normalize(childPath) === normalize(contract.path)) {
			diagnostics.push({
				severity: "error",
				code: "child_self_reference",
				message: "Child Index must not reference the current contract file.",
				path: contract.path,
			});
		}
		if (
			!childPath.startsWith(`${dir}/`) &&
			normalize(dir) !== normalize(root)
		) {
			diagnostics.push({
				severity: "warning",
				code: "child_not_descendant",
				message: `Child Index usually points below the current domain: ${child.path}`,
				path: contract.path,
			});
		}
	}
	return diagnostics;
}

function parseParent(lines: string[]): string | null {
	const value = parseList(lines)[0];
	if (!value || value === "(root)") {
		return null;
	}
	return stripBackticks(value);
}

function parseChildIndex(
	lines: string[],
	path: string,
): PlannerContractChildIndexEntry[] {
	const entries: PlannerContractChildIndexEntry[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed === "- (none)") continue;
		const match = /^-\s+`([^`]+)`\s*:\s*(.+)$/.exec(trimmed);
		if (match) {
			entries.push({
				path: match[1].trim(),
				description: match[2].trim(),
			});
			continue;
		}
		const fallback = /^-\s+(.+)$/.exec(trimmed);
		if (fallback) {
			entries.push({
				path: stripBackticks(fallback[1].trim()),
				description: `Unstructured Child Index entry in ${path}`,
			});
		}
	}
	return entries;
}

function childIndexArray(value: unknown): PlannerContractChildIndexEntry[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		throw new TypeError("childIndex must be an array.");
	}
	return value.map((entry) => {
		const record = asObject(entry);
		return {
			path: requiredString(record, "path"),
			description: requiredString(record, "description"),
		};
	});
}

function parseList(lines: string[]): string[] {
	return lines
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => line.replace(/^-\s*/, "").trim())
		.filter((line) => line.length > 0 && line !== "(none)");
}

function sectionText(lines: string[]): string {
	return lines
		.join("\n")
		.replace(/^\s*-\s*/gm, "")
		.trim();
}

function formatChildIndex(
	entries: readonly PlannerContractChildIndexEntry[],
): string[] {
	return entries.length > 0
		? entries.map((entry) => `- \`${entry.path}\`: ${entry.description}`)
		: ["- (none)"];
}

function formatList(values: readonly string[], empty = "(none)"): string[] {
	return values.length > 0
		? values.map((value) => `- ${value}`)
		: [`- ${empty}`];
}

function formatIndentedList(
	values: readonly string[],
	empty = "(none)",
): string[] {
	return values.length > 0
		? values.map((value) => `  - ${value}`)
		: [`  - ${empty}`];
}

function formatScanResult(
	result: PlannerContractScanResult & {
		queue: string[];
		diagnostics: string[];
	},
): string {
	return [
		"Planner contract scan complete for this batch.",
		`Scanned directories: ${result.scannedDirectories.length}`,
		`Discovered contract files: ${result.discoveredPaths.length}`,
		`Remaining directories: ${result.queue.length}`,
		result.complete
			? "Scan is complete. Use planner_contract_route before source reads."
			: "Scan is incomplete. Call planner_contract_scan again to continue.",
	].join("\n");
}

function formatRouteResult(
	chains: readonly PlannerContractChainRecord[],
): string {
	return [
		"Planner contract route selected.",
		...chains.flatMap((chain) => [
			`Target: ${chain.targetPath}`,
			`Chain: ${chain.chain.length ? chain.chain.join(" -> ") : "(none)"}`,
		]),
		"Read the nearest relevant contract first with planner_contract_read, then ancestors as needed.",
	].join("\n");
}

function formatDiagnostic(diagnostic: PlannerContractParseDiagnostic): string {
	return `${diagnostic.severity}:${diagnostic.code}: ${diagnostic.message}`;
}

function countOccurrences(value: string, pattern: string): number {
	let count = 0;
	let index = value.indexOf(pattern);
	while (index >= 0) {
		count += 1;
		index = value.indexOf(pattern, index + pattern.length);
	}
	return count;
}

function isKnownSectionHeading(value: string): value is ContractSectionHeading {
	return SECTION_HEADINGS.includes(value as ContractSectionHeading);
}

function resolveTargetPath(root: string, path: string): string {
	return normalize(isAbsolutePath(path) ? path : resolve(root, path));
}

function isPathInside(root: string, path: string): boolean {
	const rel = relative(normalize(root), normalize(path));
	return rel === "" || (!rel.startsWith("..") && !isAbsolutePath(rel));
}

function isAbsolutePath(path: string): boolean {
	return isAbsolute(path);
}

function looksLikeFilePath(path: string): boolean {
	return /\.[A-Za-z0-9]+$/.test(basename(path));
}

function stripBackticks(value: string): string {
	return value.replace(/^`|`$/g, "").trim();
}

function sha256(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function uniqueStrings(values: readonly string[]): string[] {
	return [...new Set(values.filter(Boolean))];
}

function requireWorktreePath(state: PlanStateRecord): string {
	if (!state.worktreePath) {
		throw new Error("Planner contract tools require state.worktreePath.");
	}
	return state.worktreePath;
}

function asObject(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function requiredString(params: Record<string, unknown>, key: string): string {
	const value = params[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError(`${key} must be a non-empty string.`);
	}
	return value.trim();
}

function optionalString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: null;
}

function stringArray(
	value: unknown,
	key: string,
	allowEmpty = false,
): string[] {
	if (!Array.isArray(value)) {
		if (allowEmpty && value === undefined) return [];
		throw new TypeError(`${key} must be a string array.`);
	}
	const normalized = [
		...new Set(
			value
				.map((entry) => {
					if (typeof entry !== "string") {
						throw new TypeError(`${key} must be a string array.`);
					}
					return entry.trim();
				})
				.filter(Boolean),
		),
	];
	if (!allowEmpty && normalized.length === 0) {
		throw new TypeError(`${key} must contain at least one entry.`);
	}
	return normalized;
}

function positiveIntegerOrUndefined(
	value: unknown,
	key: string,
): number | undefined {
	if (value === undefined) return undefined;
	const minimum = key === "cursor" ? 0 : 1;
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < minimum
	) {
		throw new TypeError(
			`${key} must be an integer greater than or equal to ${minimum}.`,
		);
	}
	return value;
}

function enumValue<const T extends readonly string[]>(
	value: unknown,
	values: T,
	key: string,
): T[number] {
	if (
		typeof value === "string" &&
		(values as readonly string[]).includes(value)
	) {
		return value as T[number];
	}
	throw new TypeError(`${key} must be one of: ${values.join(", ")}.`);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function applied(
	toolName: PlannerContractToolName,
	text: string,
	details: unknown,
): PlannerContractToolResult {
	return { status: "applied", toolName, text, details };
}

function blocked(
	toolName: PlannerContractToolName,
	text: string,
): PlannerContractToolResult {
	return { status: "blocked", toolName, text, details: null };
}
