import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createPathPerturbationExtension } from "../../../selfpi/src/index.ts";
import { createHarness, getAssistantTexts, type Harness } from "./harness.ts";

describe("SelfPi path perturbation extension", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("injects one configured path failure while unmatched and later reads execute normally", async () => {
		const executedPaths: string[] = [];
		const readTool: AgentTool = {
			name: "read",
			label: "read",
			description: "Read a file",
			parameters: Type.Object({ path: Type.String() }),
			execute: async (_toolCallId, input) => {
				const path = typeof input === "object" && input !== null && "path" in input ? String(input.path) : "";
				executedPaths.push(path);
				return { content: [{ type: "text", text: `read:${path}` }], details: undefined };
			},
		};
		const perturbation = createPathPerturbationExtension({
			version: 1,
			path: "src/config.ts",
			error: "configured path failure",
		});
		const harness = await createHarness({
			tools: [readTool],
			extensionFactories: [perturbation.extension],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "src/other.ts" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("read", { path: "src/config.ts" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("read", { path: "src/config.ts" }), { stopReason: "toolUse" }),
			(context) => {
				const results = context.messages
					.filter((message) => message.role === "toolResult")
					.flatMap((message) => message.content)
					.filter((part): part is { type: "text"; text: string } => part.type === "text")
					.map((part) => part.text);
				return fauxAssistantMessage(results.join("|"));
			},
		]);

		await harness.session.prompt("Read the files");

		expect(getAssistantTexts(harness).at(-1)).toBe("read:src/other.ts|configured path failure|read:src/config.ts");
		expect(executedPaths).toEqual(["src/other.ts", "src/config.ts"]);
		expect(perturbation.getRecord()).toEqual({
			version: 1,
			fired: true,
			toolCallSequence: 2,
			toolCallId: expect.any(String),
			path: "src/config.ts",
			error: "configured path failure",
		});
	});
});
