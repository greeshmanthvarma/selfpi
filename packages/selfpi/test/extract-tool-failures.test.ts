import { describe, expect, it } from "vitest";
import { buildToolCodeHeldInEvidence, extractToolFailureSignatures } from "../src/index.ts";

describe("tool-code failure extraction and held-in evidence", () => {
	it("extracts failed tool results across tool names", () => {
		const sessionJsonl = [
			{ type: "session", version: 3, id: "session-1", timestamp: "2026-09-18T00:00:00Z", cwd: "/repo" },
			{
				type: "message",
				id: "bash-call-entry",
				parentId: null,
				timestamp: "2026-09-18T00:00:01Z",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "bash-call",
							name: "bash",
							arguments: { command: "./scripts/probe.sh" },
						},
					],
				},
			},
			{
				type: "message",
				id: "bash-result-entry",
				parentId: "bash-call-entry",
				timestamp: "2026-09-18T00:00:02Z",
				message: {
					role: "toolResult",
					toolCallId: "bash-call",
					toolName: "bash",
					content: [{ type: "text", text: "ERROR_CODE=dyn-13\n\nCommand exited with code 1" }],
					isError: true,
				},
			},
			{
				type: "message",
				id: "edit-call-entry",
				parentId: "bash-result-entry",
				timestamp: "2026-09-18T00:00:03Z",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "edit-call",
							name: "edit",
							arguments: {
								path: "src/flags.ts",
								edits: [{ oldText: 'MODE: "draft"', newText: 'MODE: "ready"' }],
							},
						},
					],
				},
			},
			{
				type: "message",
				id: "edit-result-entry",
				parentId: "edit-call-entry",
				timestamp: "2026-09-18T00:00:04Z",
				message: {
					role: "toolResult",
					toolCallId: "edit-call",
					toolName: "edit",
					content: [{ type: "text", text: "Could not edit file: src/flags.ts. oldText matched multiple times." }],
					isError: true,
				},
			},
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n");

		const signatures = extractToolFailureSignatures(sessionJsonl, {
			taskId: "tool-code-held-in-02",
			verifiedCompletion: false,
			reason: "artifact_missing",
		});
		expect(signatures).toHaveLength(2);
		expect(signatures[0]).toMatchObject({
			toolName: "bash",
			arguments: { command: "./scripts/probe.sh" },
			subsequentToolCalls: [
				{
					sourceEntryId: "edit-call-entry",
					toolName: "edit",
				},
			],
		});
		expect(signatures[1]).toMatchObject({
			toolName: "edit",
			subsequentToolCalls: [],
		});

		const bashOnly = extractToolFailureSignatures(
			sessionJsonl,
			{
				taskId: "tool-code-held-in-02",
				verifiedCompletion: false,
				reason: "artifact_missing",
			},
			{ toolNames: ["bash"] },
		);
		expect(bashOnly).toHaveLength(1);
		expect(bashOnly[0]?.toolName).toBe("bash");
	});

	it("builds sealed held-in evidence from the failure catalog without spoon-feeding a patch", () => {
		const evidence = buildToolCodeHeldInEvidence(
			[
				{
					id: "tool-code-held-in-01",
					set: "held_in",
					repository: { url: "selfpi-corpus:tool-code-corpus-v1/repositories/x.bundle", commit: "a".repeat(40) },
					input: "Find the runtime configuration module.",
					verifier: { id: "tool-code-held-in-01", digest: `sha256:${"b".repeat(64)}` },
				},
				{
					id: "tool-code-held-in-02",
					set: "held_in",
					repository: { url: "selfpi-corpus:tool-code-corpus-v1/repositories/y.bundle", commit: "c".repeat(40) },
					input: "Run ./scripts/probe.sh and capture ERROR_CODE.",
					verifier: { id: "tool-code-held-in-02", digest: `sha256:${"d".repeat(64)}` },
				},
			],
			{
				"tool-code-held-in-01": {
					version: 1,
					toolName: "read",
					arguments: { path: "config/app.json" },
					errorContent: "ENOENT: no such file or directory, access 'config/app.json'",
					mechanism: "read returns opaque missing-path errors without nearby-path guidance",
				},
				"tool-code-held-in-02": {
					version: 1,
					toolName: "bash",
					arguments: { command: "./scripts/probe.sh" },
					errorContent: "ERROR_CODE=dyn-13\n\nCommand exited with code 1",
					mechanism: "bash non-zero exits must keep stderr actionable",
				},
			},
		);

		expect(evidence.heldInFailures).toHaveLength(2);
		expect(evidence.heldInFailures[1]).toMatchObject({
			taskId: "tool-code-held-in-02",
			toolName: "bash",
			subsequentToolCalls: [],
		});
		const serialized = JSON.stringify(evidence);
		expect(serialized).toContain("opaque missing-path");
		expect(serialized).toContain("held-in completion gain");
		expect(serialized).not.toContain("applyPathRecoveryPolicy");
		expect(serialized).not.toContain("Inspect repository files before choosing a corrected path");
		expect(evidence.redactedRepresentativeTraces[0]?.entries.map((entry) => entry.role)).toEqual([
			"task",
			"tool",
			"mechanism",
			"outcome",
			"gap",
		]);
	});
});
