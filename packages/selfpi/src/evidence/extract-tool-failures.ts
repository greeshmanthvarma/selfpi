import { migrateSessionEntries, parseSessionEntries } from "@earendil-works/pi-coding-agent";
import type { VerificationResult } from "../evaluation/verify-task.ts";

export interface SubsequentToolCall {
	readonly sourceEntryId: string;
	readonly toolName: string;
	readonly arguments: Readonly<Record<string, unknown>>;
}

export interface ToolFailureSignature {
	readonly version: 1;
	readonly taskId: string;
	readonly verifiedCompletion: boolean;
	readonly verification: {
		readonly verifiedCompletion: boolean;
		readonly reason: VerificationResult["reason"];
	};
	readonly toolCallId: string;
	readonly toolName: string;
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

function normalizeArgumentValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return Object.freeze(value.map(normalizeArgumentValue));
	}
	if (typeof value === "object" && value !== null) {
		return Object.freeze(
			Object.fromEntries(
				Object.entries(value)
					.sort(([left], [right]) => left.localeCompare(right))
					.map(([key, entry]) => [key, normalizeArgumentValue(entry)]),
			),
		);
	}
	return value;
}

export interface ExtractToolFailureOptions {
	readonly toolNames?: readonly string[];
}

export function extractToolFailureSignatures(
	sessionJsonl: string,
	verification: VerificationResult,
	options: ExtractToolFailureOptions = {},
): readonly ToolFailureSignature[] {
	const allowed = options.toolNames === undefined ? undefined : new Set(options.toolNames);
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
					arguments: normalizeArgumentValue(part.arguments) as Readonly<Record<string, unknown>>,
					entryIndex,
				});
			}
		}
	}

	const callsById = new Map(toolCalls.map((call) => [call.toolCallId, call]));
	const signatures: ToolFailureSignature[] = [];
	for (const [entryIndex, entry] of entries.entries()) {
		if (entry.type !== "message" || entry.message.role !== "toolResult" || !entry.message.isError) {
			continue;
		}
		if (allowed !== undefined && !allowed.has(entry.message.toolName)) {
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
				verifiedCompletion: verification.verifiedCompletion,
				verification: Object.freeze({
					verifiedCompletion: verification.verifiedCompletion,
					reason: verification.reason,
				}),
				toolCallId: toolCall.toolCallId,
				toolName: toolCall.toolName,
				arguments: toolCall.arguments,
				errorContent,
				sourceEntryIds: Object.freeze({ toolCall: toolCall.sourceEntryId, toolResult: entry.id }),
				subsequentToolCalls: Object.freeze(subsequentToolCalls),
			}),
		);
	}
	return Object.freeze(signatures);
}
