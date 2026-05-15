import type { ArtifactReadResult } from "../artifacts/planner-artifacts";
import { getMarkdownSection } from "../instructions/section-parser";
import type { PlannerFs } from "../settings/fs";
import { getInstructionContent } from "../settings/loader";
import type { InstructionName, SettingsLoadResult } from "../settings/schema";

export interface PromptStateEntry {
	name: string;
	value: string | number | boolean | null;
}

export interface PromptArtifactReference {
	name: string;
	path: string;
	content?: string;
	includeContent?: boolean;
}

export interface AssemblePlannerPromptRequest {
	instructionName: InstructionName;
	sectionName?: string;
	includeDetails?: boolean;
	state?: PromptStateEntry[];
	artifacts?: PromptArtifactReference[];
	extraInstructions?: string[];
}

export interface AssemblePlannerPromptResult {
	prompt: string;
	instruction: string;
	artifactPaths: string[];
}

function compactParts(parts: string[]): string {
	return parts
		.map((part) => part.trim())
		.filter((part) => part.length > 0)
		.join("\n\n");
}

function readInstruction(
	loadResult: SettingsLoadResult,
	fs: PlannerFs,
	request: AssemblePlannerPromptRequest,
): string {
	const content = getInstructionContent(
		loadResult,
		fs,
		request.instructionName,
	);
	if (!request.sectionName) return content.trim();

	const section = getMarkdownSection(content, request.sectionName);
	if (!section) {
		throw new Error(
			`Instruction section not found: ${request.instructionName}:${request.sectionName}`,
		);
	}
	if (!request.includeDetails) return section;

	const details = getMarkdownSection(content, "details");
	return compactParts(details ? [section, details] : [section]);
}

function formatState(entries: PromptStateEntry[] = []): string {
	if (entries.length === 0) return "";
	return [
		"## Current State",
		...entries.map((entry) => `- ${entry.name}: ${entry.value ?? "null"}`),
	].join("\n");
}

function formatArtifacts(artifacts: PromptArtifactReference[] = []): string {
	if (artifacts.length === 0) return "";

	const lines = ["## Artifacts"];
	for (const artifact of artifacts) {
		lines.push(`- ${artifact.name}: ${artifact.path}`);
		if (artifact.includeContent && artifact.content !== undefined) {
			lines.push("");
			lines.push(`### ${artifact.name}`);
			lines.push("```text");
			lines.push(artifact.content);
			lines.push("```");
		}
	}
	return lines.join("\n");
}

function formatExtraInstructions(extraInstructions: string[] = []): string {
	if (extraInstructions.length === 0) return "";
	return ["## Additional Instructions", ...extraInstructions].join("\n");
}

export function artifactReference<TName extends string>(
	artifact: ArtifactReadResult<TName>,
	options: { includeContent?: boolean } = {},
): PromptArtifactReference {
	return {
		name: artifact.name,
		path: artifact.path,
		content: artifact.content,
		includeContent: options.includeContent,
	};
}

export function assemblePlannerPrompt(
	loadResult: SettingsLoadResult,
	fs: PlannerFs,
	request: AssemblePlannerPromptRequest,
): AssemblePlannerPromptResult {
	const instruction = readInstruction(loadResult, fs, request);
	const artifacts = request.artifacts ?? [];
	const prompt = compactParts([
		"## Planner Instruction",
		instruction,
		formatState(request.state),
		formatArtifacts(artifacts),
		formatExtraInstructions(request.extraInstructions),
	]);

	return {
		prompt,
		instruction,
		artifactPaths: artifacts.map((artifact) => artifact.path),
	};
}
