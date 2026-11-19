import type { BeforeAgentStartEventResult } from "@earendil-works/pi-coding-agent";

/** Separator between context blocks delivered in the same hidden message. */
const CONTEXT_BLOCK_SEPARATOR = "\n\n";

interface ContextBlock<Details> {
	text: string;
	details?: Details;
}

/**
 * Hidden context collected on `session_start`/`session_compact` and delivered
 * once, on the next `before_agent_start`, as a single non-displayed message.
 * Shared by every extension that injects session context so they all follow
 * the same lifecycle instead of reimplementing it.
 */
export class PendingContext<Details = undefined> {
	private blocks: ContextBlock<Details>[] = [];
	private readonly customType: string;

	constructor(customType: string) {
		this.customType = customType;
	}

	/** Queues one block; empty text is ignored. */
	add(text: string, details?: Details): void {
		if (!text.trim()) return;
		this.blocks.push({ text, ...(details !== undefined ? { details } : {}) });
	}

	/** Drops everything queued (a new session cycle starts). */
	reset(): void {
		this.blocks = [];
	}

	/** Keeps only the blocks whose details satisfy `keep` (blocks without details are dropped). */
	retain(keep: (details: Details) => boolean): void {
		this.blocks = this.blocks.filter((block) => block.details !== undefined && keep(block.details));
	}

	/** Details of every queued block, in delivery order. */
	queuedDetails(): Details[] {
		return this.blocks.flatMap((block) => (block.details !== undefined ? [block.details] : []));
	}

	/**
	 * Result for `before_agent_start`: the queued blocks in one hidden message,
	 * or `undefined` when nothing is queued. Taking it empties the queue, so the
	 * same context is never delivered twice in one cycle.
	 */
	take(): BeforeAgentStartEventResult | undefined {
		if (this.blocks.length === 0) return undefined;
		const content = this.blocks.map((block) => block.text).join(CONTEXT_BLOCK_SEPARATOR);
		const details = this.queuedDetails();
		this.reset();
		return { message: { customType: this.customType, content, display: false, ...(details.length > 0 ? { details } : {}) } };
	}
}
