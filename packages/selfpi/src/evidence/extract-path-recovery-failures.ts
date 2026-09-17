import { migrateSessionEntries, parseSessionEntries } from "@earendil-works/pi-coding-agent";
import type { VerificationResult } from "../evaluation/verify-task.ts";

export interface SubsequentToolCall {
	readonly sourceEntryId: string;
	readonly toolName: string;
	readonly arguments: Readonly<Record<string, unknown>>;
}

export interface PathRecoveryFailureSignature {
	readonly version: 1;
	readonly taskId: string;
	readonly verifiedCompletion: false;
	readonly toolCallId: string;
	readonly arguments: Readonly<Record<string, unknown>>;
	readonly errorContent: string;
	readonly sourceEntryIds: {
		readonly toolCall: string;
		readonly toolResult: string;
	};
	readonly subsequentToolCalls: readonly SubsequentToolCall[];
}

interface RecordedToolCall extends SubsequentToolCall {
	readonly toolCallId: string;
	readonly entryIndex: number;
}

export function extractPathRecoveryFailureSignatures(
	sessionJsonl: string,
	verification: VerificationResult,
): readonly PathRecoveryFailureSignature[] {
	if (verification.verifiedCompletion) {
		return Object.freeze([]);
	}

	const entries = parseSessionEntries(sessionJsonl);
	migrateSessionEntries(entries);
	const toolCalls: RecordedToolCall[] = [];
	for (const [entryIndex, entry] of entries.entries()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") {
			continue;
		}
		for (const part of entry.message.content) {
			if (part.type === "toolCall") {
				toolCalls.push({
					toolCallId: part.id,
					sourceEntryId: entry.id,
					toolName: part.name,
					arguments: Object.freeze({ ...part.arguments }),
					entryIndex,
				});
			}
		}
	}

	const callsById = new Map(toolCalls.map((call) => [call.toolCallId, call]));
	const signatures: PathRecoveryFailureSignature[] = [];
	for (const [entryIndex, entry] of entries.entries()) {
		if (
			entry.type !== "message" ||
			entry.message.role !== "toolResult" ||
			entry.message.toolName !== "read" ||
			!entry.message.isError
		) {
			continue;
		}
		const toolCall = callsById.get(entry.message.toolCallId);
		if (!toolCall) {
			continue;
		}
		const errorContent = entry.message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		const subsequentToolCalls = toolCalls
			.filter((call) => call.entryIndex > entryIndex)
			.map(({ sourceEntryId, toolName, arguments: args }) =>
				Object.freeze({ sourceEntryId, toolName, arguments: args }),
			);
		signatures.push(
			Object.freeze({
				version: 1,
				taskId: verification.taskId,
				verifiedCompletion: false,
				toolCallId: toolCall.toolCallId,
				arguments: toolCall.arguments,
				errorContent,
				sourceEntryIds: Object.freeze({ toolCall: toolCall.sourceEntryId, toolResult: entry.id }),
				subsequentToolCalls: Object.freeze(subsequentToolCalls),
			}),
		);
	}
	return Object.freeze(signatures);
}
