export const INSTRUCTION_KEYS = [
	"init",
	"intake",
	"discovery",
	"planning",
	"execution",
	"finalize",
	"done",
	"recovery",
	"tdd",
	"experiment",
	"refactor",
	"git",
	"git-commit",
] as const;

export type InstructionKey = (typeof INSTRUCTION_KEYS)[number];
export type InstructionDefaults = Record<InstructionKey, string>;
export type InstructionAppendSource = "project" | "global" | null;
export type InstructionSectionName = "manual-compact" | "auto-compact";

export interface InstructionPaths {
	instructionsDir: string;
	defaultsDir: string;
	globalAppendDir: string;
	projectAppendDir: string;
}

export interface SyncedInstructionFile {
	key: InstructionKey;
	defaultPath: string;
	globalAppendPath: string;
	defaultAction: "created" | "updated" | "unchanged";
	globalAppendAction: "created" | "unchanged";
}

export interface InstructionContent {
	key: InstructionKey;
	defaultPath: string;
	appendPath: string | null;
	appendSource: InstructionAppendSource;
	content: string;
}

export interface InstructionSection {
	name: string;
	content: string;
	found: boolean;
}
