/**
 * What actually went to the provider — and whether its HEAD changed since last time.
 *
 * The planner can measure the messages it hands Pi. It cannot see the other half of a
 * prompt: the system prompt Pi builds and the tool schemas it sends. On a local backend
 * those are not a footnote — the chat template renders the tool list INTO the system
 * message, so the tools sit at the very front of the prompt, ahead of every word anyone
 * has said. Measured on a real planner session: a 32 197-character system prompt plus
 * 61 023 characters of schemas for 65 tools, 52 015 of them the planner's own 54 — about
 * 23 300 tokens, ~18% of a 131072 window that no compaction can ever reclaim.
 *
 * Which makes the head the one thing that must not change without a reason. Every serving
 * backend (llama.cpp, vLLM, SGLang, Anthropic's cache) reuses exactly one thing: a prefix
 * of bytes it has already read. Change byte zero and the whole prompt is re-read — the
 * tokens are the same, the seconds are not.
 *
 * A head change between RUNS is expected: the tool set legitimately differs. Between two
 * calls of ONE run, nothing about the model's situation changed and the backend threw away
 * everything it had read; that is the defect this names.
 *
 * It stays armed because `setActiveTools` is a global setter and this extension is not the
 * only one writing it — the same session runs pi-telegram-manager, confirmed by four
 * compactions it answered through `session_before_compact`. Ported from that extension's
 * `core/payload-probe.ts`, which found the class of bug this one was on the wrong side of:
 * two extensions each rebuilding the whole active tool list on every request, resurrecting
 * each other's hidden tools and rewriting the head mid-turn.
 *
 * Structural typing, no SDK import: a payload is whatever the provider was handed. Every
 * function here is pure, so the whole probe is testable with plain objects.
 */

/** The parts of a provider payload we can compare. Provider-agnostic by shape. */
interface PayloadLike {
	messages?: unknown;
	tools?: unknown;
	system?: unknown;
}

/** One request, reduced to what decides whether a backend can reuse it. */
export interface PayloadShape {
	/** Characters in the head: the system prompt plus the serialized tool schemas. */
	headChars: number;
	/** The tools the model was offered, in the order it was offered them. */
	toolNames: string[];
	/** Characters in the tool schemas alone — usually most of the head. */
	toolChars: number;
	/** Characters in the conversation. */
	messageChars: number;
	messages: number;
	/** A cheap fingerprint of the head. Equal heads → equal fingerprints. */
	headKey: string;
}

/** How this request compares with the one before it. */
export interface PayloadDelta {
	/** The head is byte-identical to the previous request's. This is the good case. */
	headStable: boolean;
	/** Tools the model gained since the previous request. */
	toolsAdded: string[];
	/** Tools it lost. */
	toolsRemoved: string[];
	/** Characters the head grew (negative: shrank). */
	headCharsDelta: number;
}

/** A head that changed, and everything needed to say who changed it. */
export interface HeadChurn {
	at: number;
	/** True when the head changed BETWEEN CALLS OF ONE RUN. */
	midRun: boolean;
	/**
	 * The tools the model was offered are NOT the ones we last set: the list was
	 * rewritten by something outside this extension.
	 */
	foreign: boolean;
	delta: PayloadDelta;
	shape: PayloadShape;
}

function textOf(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined || value === null) return "";
	return JSON.stringify(value);
}

/**
 * The name of a tool as the provider was given it. OpenAI-style wraps it
 * (`{type:"function", function:{name}}`); Anthropic-style does not (`{name}`).
 */
function toolName(tool: unknown): string {
	if (typeof tool !== "object" || tool === null) return "?";
	const record = tool as { name?: unknown; function?: { name?: unknown } };
	const name = record.function?.name ?? record.name;
	return typeof name === "string" ? name : "?";
}

/**
 * Whether a message is the system prompt. OpenAI-completions carries it as the
 * first message (`role: "system"`); Anthropic carries it in a `system` field of
 * its own, which {@link describePayload} reads separately.
 */
function isSystemMessage(message: unknown): boolean {
	if (typeof message !== "object" || message === null) return false;
	const role = (message as { role?: unknown }).role;
	return role === "system" || role === "developer";
}

/**
 * A stable fingerprint of a string. Not cryptographic and does not need to be: it
 * answers one question — "are these the same bytes?" — for a value we already hold
 * in full.
 */
export function fingerprintHead(text: string): string {
	let h1 = 0x811c9dc5;
	let h2 = 0x01000193;
	for (let i = 0; i < text.length; i += 1) {
		const c = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 0x01000193);
		h2 = Math.imul(h2 + c, 0x85ebca6b) ^ (h2 >>> 13);
	}
	const a = (h1 >>> 0).toString(16).padStart(8, "0");
	const b = (h2 >>> 0).toString(16).padStart(8, "0");
	return `${a}${b}:${text.length}`;
}

/** Reduce a provider payload to the shape a prefix cache cares about. */
export function describePayload(payload: unknown): PayloadShape {
	const body = (
		typeof payload === "object" && payload !== null ? payload : {}
	) as PayloadLike;
	const messages = Array.isArray(body.messages) ? body.messages : [];
	const tools = Array.isArray(body.tools) ? body.tools : [];

	const leading = messages.filter(isSystemMessage);
	const systemText = textOf(body.system) + leading.map(textOf).join("");
	// No tools → no tool bytes. Faithful to the payload, which omits the key
	// entirely when the list is empty, and to the prompt, where it renders to
	// nothing.
	const toolsText = tools.length > 0 ? JSON.stringify(tools) : "";
	const conversation = messages.filter((message) => !isSystemMessage(message));
	const messageChars = conversation.reduce(
		(sum, message) => sum + textOf(message).length,
		0,
	);

	return {
		headChars: systemText.length + toolsText.length,
		toolNames: tools.map(toolName),
		toolChars: toolsText.length,
		messageChars,
		messages: conversation.length,
		headKey: fingerprintHead(`${systemText} ${toolsText}`),
	};
}

/** Compare a request with the one before it. */
export function comparePayloads(
	previous: PayloadShape,
	next: PayloadShape,
): PayloadDelta {
	const before = new Set(previous.toolNames);
	const after = new Set(next.toolNames);
	return {
		headStable: previous.headKey === next.headKey,
		toolsAdded: next.toolNames.filter((name) => !before.has(name)),
		toolsRemoved: previous.toolNames.filter((name) => !after.has(name)),
		headCharsDelta: next.headChars - previous.headChars,
	};
}

/** Whether two tool lists hold the same names (order is not the question here). */
function sameTools(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	const seen = new Set(a);
	return b.every((name) => seen.has(name));
}

/**
 * Watches every provider request and reports the ones whose head changed.
 *
 * Two questions decide whether a head change is worth reporting, and they are
 * different questions:
 *
 *  - **When?** Between runs is expected. Between two calls of ONE run, nothing
 *    about the model's situation changed and the prefix was thrown away.
 *  - **Who?** `setActiveTools` is a global setter with no notion of whose tools
 *    are whose, and this extension is not the only one writing it. A mid-run
 *    change may be a stranger's — the thing worth naming — or it may be ours,
 *    which is a cost we chose with our eyes open, not news.
 *
 * Only a change we did not make is worth an alarm, and an alarm that cannot
 * recognise its owner's footsteps is one nobody keeps armed — so {@link record}
 * takes the list WE set and reports both answers to the caller, which decides.
 *
 * It keeps only the previous shape. Nothing here accumulates a history: a
 * session-long log of head changes would be a reporting surface, and this
 * module has exactly one caller, which reads each churn once and then notifies.
 */
export class PrefixWatch {
	private last: PayloadShape | null = null;
	/** Requests seen since the current run began — 0 means the next one opens a run. */
	private requestsThisRun = 0;

	constructor(private readonly now: () => number = Date.now) {}

	/** A run started: the next request is its first, so a change there is not mid-run. */
	runStarted(): void {
		this.requestsThisRun = 0;
	}

	/**
	 * Record one provider request. Returns the churn it caused, if any.
	 *
	 * `ours` is the tool list we last wrote, or `null` when we have not written one
	 * — the only way to tell a head we rewrote from a head somebody else did.
	 * Unknown ownership is not an accusation: we cannot claim it and we will not
	 * blame anyone for it.
	 */
	record(payload: unknown, ours?: readonly string[] | null): HeadChurn | null {
		const shape = describePayload(payload);
		const previous = this.last;
		this.last = shape;
		const midRun = this.requestsThisRun > 0;
		this.requestsThisRun += 1;
		if (!previous) return null;
		const delta = comparePayloads(previous, shape);
		if (delta.headStable) return null;
		const foreign = ours != null && !sameTools(shape.toolNames, ours);
		return { at: this.now(), midRun, foreign, delta, shape };
	}
}

/**
 * The one-line report for a mid-run foreign churn. Local only — the caller passes
 * it to `ctx.ui.notify`; nothing is ever sent anywhere.
 */
export function formatHeadChurnWarning(churn: HeadChurn): string {
	const moved =
		churn.delta.headCharsDelta > 0
			? `grew ${churn.delta.headCharsDelta}`
			: `shrank ${-churn.delta.headCharsDelta}`;
	const parts = [
		`Prompt head rewritten mid-run: ${moved} chars (~${Math.round(Math.abs(churn.delta.headCharsDelta) / 4)} tokens).`,
		"The prefix cache was discarded and the whole prompt re-read.",
	];
	if (churn.delta.toolsAdded.length > 0) {
		parts.push(`Tools added: ${churn.delta.toolsAdded.join(", ")}.`);
	}
	if (churn.delta.toolsRemoved.length > 0) {
		parts.push(`Tools removed: ${churn.delta.toolsRemoved.join(", ")}.`);
	}
	parts.push("This is a local check — nothing was sent anywhere.");
	return parts.join(" ");
}
