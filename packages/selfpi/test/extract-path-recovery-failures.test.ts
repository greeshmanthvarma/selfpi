import { describe, expect, it } from "vitest";
import { extractPathRecoveryFailureSignatures } from "../src/index.ts";

describe("path recovery failure extraction", () => {
	it("extracts failed reads from a failed task and excludes unrelated tool failures", () => {
		const sessionJsonl = [
			{ type: "session", version: 3, id: "session-1", timestamp: "2026-09-17T00:00:00Z", cwd: "/repo" },
			{
				type: "message",
				id: "read-call-entry",
				parentId: null,
				timestamp: "2026-09-17T00:00:01Z",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "read-call", name: "read", arguments: { path: "src/config.ts" } }],
				},
			},
			{
				type: "message",
				id: "read-result-entry",
				parentId: "read-call-entry",
				timestamp: "2026-09-17T00:00:02Z",
				message: {
					role: "toolResult",
					toolCallId: "read-call",
					toolName: "read",
					content: [{ type: "text", text: "src/config.ts does not exist" }],
					isError: true,
				},
			},
			{
				type: "message",
				id: "bash-call-entry",
				parentId: "read-result-entry",
				timestamp: "2026-09-17T00:00:03Z",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "bash-call", name: "bash", arguments: { command: "exit 1" } }],
				},
			},
			{
				type: "message",
				id: "bash-result-entry",
				parentId: "bash-call-entry",
				timestamp: "2026-09-17T00:00:04Z",
				message: {
					role: "toolResult",
					toolCallId: "bash-call",
					toolName: "bash",
					content: [{ type: "text", text: "command failed" }],
					isError: true,
				},
			},
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n");

		const signatures = extractPathRecoveryFailureSignatures(sessionJsonl, {
			taskId: "path-recovery-01",
			verifiedCompletion: false,
			reason: "artifact_missing",
		});

		expect(signatures).toEqual([
			{
				version: 1,
				taskId: "path-recovery-01",
				verifiedCompletion: false,
				toolCallId: "read-call",
				arguments: { path: "src/config.ts" },
				errorContent: "src/config.ts does not exist",
				sourceEntryIds: { toolCall: "read-call-entry", toolResult: "read-result-entry" },
				subsequentToolCalls: [
					{ sourceEntryId: "bash-call-entry", toolName: "bash", arguments: { command: "exit 1" } },
				],
			},
		]);
	});
});
