import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { DashboardPalette } from "./dashboard-model";

/**
 * Pure transcript projection + rendering for the planner workspace chat pane.
 *
 * `projectSessionEntries` turns Pi session entries into a flat list of display
 * rows. `renderTranscript` renders those rows into bounded lines using an
 * injected palette, so the whole module is unit-testable with an identity
 * palette and plain data.
 */

export type ChatRole =
	| "user"
	| "assistant"
	| "thinking"
	| "tool"
	| "tool_result"
	| "event";

export interface ChatRow {
	role: ChatRole;
	/** Primary text (plain; may contain newlines). */
	text: string;
	/** Short label shown before the text (tool name, status, etc.). */
	label?: string;
	/** Whether this row can be expanded to show full content. */
	collapsible: boolean;
	isError?: boolean;
	/** Stable key for expand/collapse tracking. */
	key: string;
}

const MAX_COLLAPSED_LINES = 1;
const MAX_EXPANDED_LINES = 40;

export function projectSessionEntries(entries: SessionEntry[]): ChatRow[] {
	const rows: ChatRow[] = [];
	for (const entry of entries) {
		if (entry.type === "compaction") {
			rows.push({
				role: "event",
				label: "compacted",
				text: entry.summary || "(context compacted)",
				collapsible: true,
				key: entry.id,
			});
			continue;
		}
		if (entry.type === "custom_message" && entry.display) {
			rows.push({
				role: "event",
				label: entry.customType,
				text: contentToText(entry.content),
				collapsible: true,
				key: entry.id,
			});
			continue;
		}
		if (entry.type !== "message") continue;
		rows.push(...projectMessage(entry.id, entry.message));
	}
	return rows;
}

/**
 * Project an in-flight (streaming) assistant message into transcript rows.
 * Keys are namespaced so they never collide with committed session entries.
 */
export function projectLiveAssistant(message: unknown): ChatRow[] {
	return projectMessage("live", message).map((row) => ({
		...row,
		key: `live:${row.key}`,
	}));
}

function projectMessage(id: string, message: unknown): ChatRow[] {
	const role = readRole(message);
	if (role === "user") {
		return [
			{
				role: "user",
				text: contentToText(readContent(message)),
				collapsible: false,
				key: id,
			},
		];
	}
	if (role === "toolResult") {
		const toolName = readString(message, "toolName") ?? "tool";
		const isError = readBoolean(message, "isError");
		return [
			{
				role: "tool_result",
				label: `${toolName} ${isError ? "error" : "ok"}`,
				text: contentToText(readContent(message)),
				collapsible: true,
				isError,
				key: id,
			},
		];
	}
	if (role === "assistant") {
		return projectAssistantBlocks(id, readBlocks(message));
	}
	// Custom / unknown roles: show a compact event line.
	return [
		{
			role: "event",
			label: String(role),
			text: contentToText(readContent(message)),
			collapsible: true,
			key: id,
		},
	];
}

function projectAssistantBlocks(id: string, blocks: unknown[]): ChatRow[] {
	const rows: ChatRow[] = [];
	let textIndex = 0;
	let blockIndex = 0;
	for (const block of blocks) {
		const type = readString(block, "type");
		if (type === "text") {
			const text = readString(block, "text")?.trim();
			if (text) {
				rows.push({
					role: "assistant",
					text,
					collapsible: false,
					key: `${id}:t${textIndex++}`,
				});
			}
		} else if (type === "thinking") {
			const thinking = readString(block, "thinking")?.trim();
			if (thinking) {
				rows.push({
					role: "thinking",
					label: "thinking",
					text: thinking,
					collapsible: true,
					key: `${id}:think${blockIndex}`,
				});
			}
		} else if (type === "toolCall") {
			const name = readString(block, "name") ?? "tool";
			rows.push({
				role: "tool",
				label: name,
				text: argsToText(readRecord(block, "arguments")),
				collapsible: true,
				key: `${id}:tool${blockIndex}`,
			});
		}
		blockIndex++;
	}
	return rows;
}

export interface TranscriptOptions {
	width: number;
	height: number;
	/** Follow the newest output (pinned to the live tail). */
	atBottom: boolean;
	/**
	 * Absolute index of the first visible line when not following the tail.
	 * Anchoring from the top keeps the view fixed while new lines append below.
	 */
	topLine: number;
	expanded: ReadonlySet<string>;
}

export interface TranscriptResult {
	lines: string[];
	/** Total renderable lines (for scroll clamping by the caller). */
	totalLines: number;
	/** Resolved (clamped) first visible line index. */
	topLine: number;
}

export function renderTranscript(
	rows: ChatRow[],
	options: TranscriptOptions,
	palette: DashboardPalette,
): TranscriptResult {
	const width = Math.max(8, options.width);
	const height = Math.max(1, options.height);
	const all: string[] = [];
	if (rows.length === 0) {
		all.push(
			palette.dim("No conversation yet. Type below to talk to the model."),
		);
	}
	for (const row of rows) {
		for (const line of renderRow(row, width, options.expanded, palette)) {
			all.push(line);
		}
	}

	const total = all.length;
	const maxTop = Math.max(0, total - height);
	const start = options.atBottom
		? maxTop
		: Math.min(Math.max(0, options.topLine), maxTop);
	const window = all.slice(start, start + height);
	while (window.length < height) window.push("");
	return {
		lines: window.map((line) => clipPad(line, width, palette)),
		totalLines: total,
		topLine: start,
	};
}

function renderRow(
	row: ChatRow,
	width: number,
	expanded: ReadonlySet<string>,
	palette: DashboardPalette,
): string[] {
	const isExpanded = expanded.has(row.key);
	const marker = row.collapsible
		? isExpanded
			? palette.dim("▾ ")
			: palette.dim("▸ ")
		: "  ";
	const head = rowHead(row, palette);
	const bodyWidth = width;
	const textLines = splitText(row.text);
	// Non-collapsible rows (user/assistant text) are never truncated: the
	// transcript window in renderTranscript bounds what is visible, so capping
	// here would silently freeze a long streaming response mid-message.
	const limit = row.collapsible
		? isExpanded
			? MAX_EXPANDED_LINES
			: MAX_COLLAPSED_LINES
		: Number.POSITIVE_INFINITY;

	const fullWrapped: string[] = [];
	for (const raw of textLines) {
		for (const piece of wrapPlain(raw, Math.max(4, bodyWidth - 2))) {
			fullWrapped.push(piece);
		}
	}
	const wrapped = fullWrapped.slice(0, limit);
	const truncated =
		row.collapsible && !isExpanded && fullWrapped.length > wrapped.length;

	const out: string[] = [];
	const colorBody = bodyColor(row, palette);
	if (head) {
		const firstBody = wrapped.shift() ?? "";
		const suffix = truncated ? palette.dim(" …") : "";
		out.push(`${marker}${head} ${colorBody(firstBody)}${suffix}`);
	}
	for (const line of wrapped) {
		out.push(`    ${colorBody(line)}`);
	}
	if (!head && out.length === 0) out.push(marker);
	return out;
}

function rowHead(row: ChatRow, palette: DashboardPalette): string {
	switch (row.role) {
		case "user":
			return palette.accent("› you");
		case "assistant":
			return "";
		case "thinking":
			return palette.dim("✻ thinking");
		case "tool":
			return palette.warning(`⚙ ${row.label ?? "tool"}`);
		case "tool_result":
			return row.isError
				? palette.error(`↳ ${row.label ?? "result"}`)
				: palette.success(`↳ ${row.label ?? "result"}`);
		case "event":
			return palette.dim(`• ${row.label ?? "event"}`);
	}
}

function bodyColor(
	row: ChatRow,
	palette: DashboardPalette,
): (s: string) => string {
	switch (row.role) {
		case "user":
			return (s) => palette.text(s);
		case "assistant":
			return (s) => palette.text(s);
		case "thinking":
			return (s) => palette.dim(s);
		case "tool":
			return (s) => palette.muted(s);
		case "tool_result":
			return row.isError ? (s) => palette.error(s) : (s) => palette.muted(s);
		case "event":
			return (s) => palette.dim(s);
	}
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function splitText(text: string): string[] {
	return sanitizeText(text).split("\n");
}

/**
 * Make arbitrary message/tool text safe to lay out by fixed-width math:
 * expand tabs (terminals render them 1..8 cols wide but width math counts 1),
 * strip ANSI escapes and other control chars that would desync the frame.
 */
function sanitizeText(text: string): string {
	// Built from char codes so the source stays ASCII-only.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-byte stripping
	const ansi = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-byte stripping
	const control = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
	return text
		.replace(/\r/g, "")
		.replace(/\t/g, "  ")
		.replace(ansi, "")
		.replace(control, "");
}

function wrapPlain(text: string, width: number): string[] {
	if (text.length === 0) return [""];
	const words = text.split(/(\s+)/);
	const lines: string[] = [];
	let current = "";
	for (const word of words) {
		if (word.length > width) {
			if (current) {
				lines.push(current);
				current = "";
			}
			for (let i = 0; i < word.length; i += width) {
				const chunk = word.slice(i, i + width);
				if (chunk.length === width) lines.push(chunk);
				else current = chunk;
			}
			continue;
		}
		if ((current + word).length > width) {
			lines.push(current.trimEnd());
			current = word.trimStart();
		} else {
			current += word;
		}
	}
	if (current.trim().length > 0 || lines.length === 0)
		lines.push(current.trimEnd());
	return lines;
}

function clipPad(
	value: string,
	width: number,
	palette: DashboardPalette,
): string {
	const clipped = palette.clip(value, width);
	const pad = Math.max(0, width - palette.measure(clipped));
	return clipped + " ".repeat(pad);
}

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((block) => {
				if (typeof block === "string") return block;
				const type = readString(block, "type");
				if (type === "text") return readString(block, "text") ?? "";
				if (type === "image") return "[image]";
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

function argsToText(args: Record<string, unknown> | null): string {
	if (!args) return "";
	const keys = Object.keys(args);
	if (keys.length === 0) return "";
	return keys.map((key) => `${key}=${stringifyArg(args[key])}`).join(" ");
}

function stringifyArg(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === null || value === undefined) return "";
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
}

// ---------------------------------------------------------------------------
// Defensive readers for loosely-typed message blocks
// ---------------------------------------------------------------------------

function readRole(message: unknown): string {
	return readString(message, "role") ?? "unknown";
}

function readContent(message: unknown): unknown {
	if (message && typeof message === "object" && "content" in message) {
		return (message as { content: unknown }).content;
	}
	return "";
}

function readBlocks(message: unknown): unknown[] {
	const content = readContent(message);
	return Array.isArray(content) ? content : [];
}

function readString(value: unknown, key: string): string | undefined {
	if (value && typeof value === "object" && key in value) {
		const v = (value as Record<string, unknown>)[key];
		return typeof v === "string" ? v : undefined;
	}
	return undefined;
}

function readBoolean(value: unknown, key: string): boolean {
	if (value && typeof value === "object" && key in value) {
		return Boolean((value as Record<string, unknown>)[key]);
	}
	return false;
}

function readRecord(
	value: unknown,
	key: string,
): Record<string, unknown> | null {
	if (value && typeof value === "object" && key in value) {
		const v = (value as Record<string, unknown>)[key];
		return v && typeof v === "object" && !Array.isArray(v)
			? (v as Record<string, unknown>)
			: null;
	}
	return null;
}
