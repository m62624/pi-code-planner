import type { PlannerFs } from "../settings/fs";
import { getInstructionContent } from "../settings/loader";
import type { InstructionName, SettingsLoadResult } from "../settings/schema";
import { getMarkdownSection } from "./section-parser";

export interface InstructionSectionOptions {
	includeDetails?: boolean;
	detailsSectionName?: string;
	required?: boolean;
}

export interface InstructionSectionRequest extends InstructionSectionOptions {
	instructionName: InstructionName;
	sectionName: string;
}

function joinInstructionParts(parts: string[]): string {
	return parts
		.map((part) => part.trim())
		.filter((part) => part.length > 0)
		.join("\n\n");
}

export function getInstructionSectionContent(
	loadResult: SettingsLoadResult,
	fs: PlannerFs,
	request: InstructionSectionRequest,
): string | null {
	const content = getInstructionContent(
		loadResult,
		fs,
		request.instructionName,
	);
	const section = getMarkdownSection(content, request.sectionName);
	const required = request.required ?? true;

	if (!section && required) {
		throw new Error(
			`Instruction section not found: ${request.instructionName}:${request.sectionName}`,
		);
	}
	if (!section) return null;

	if (!request.includeDetails) return section;

	const details = getMarkdownSection(
		content,
		request.detailsSectionName ?? "details",
	);
	return joinInstructionParts(details ? [section, details] : [section]);
}
