import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createPathRecoveryExtension } from "../../../selfpi/src/index.ts";
import { createHarness, getAssistantTexts, type Harness } from "./harness.ts";

describe("SelfPi path recovery extension", () => {
	const harnesses: Harness[] = [];
	const failingReadTool: AgentTool = {
		name: "read",
		label: "read",
		description: "Read a file",
		parameters: Type.Object({ path: Type.String() }),
		execute: async () => {
			throw new Error("original read failure");
		},
	};

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("replaces a failed-read result only when the recovery policy returns a decision", async () => {
		const replacementHarness = await createHarness({
			tools: [failingReadTool],
			extensionFactories: [
				createPathRecoveryExtension(() => ({
					content: [{ type: "text", text: "recovery guidance" }],
				})),
			],
		});
		const noOpHarness = await createHarness({
			tools: [failingReadTool],
			extensionFactories: [createPathRecoveryExtension()],
		});
		harnesses.push(replacementHarness, noOpHarness);

		for (const harness of harnesses) {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("read", { path: "src/config.ts" }), { stopReason: "toolUse" }),
				(context) => {
					const result = context.messages.find((message) => message.role === "toolResult");
					const text =
						result?.role === "toolResult"
							? result.content
									.filter((part): part is { type: "text"; text: string } => part.type === "text")
									.map((part) => part.text)
									.join("\n")
							: "";
					return fauxAssistantMessage(text);
				},
			]);
			await harness.session.prompt("Read the configuration file");
		}

		expect(getAssistantTexts(replacementHarness).at(-1)).toBe("recovery guidance");
		expect(getAssistantTexts(noOpHarness).at(-1)).toBe("original read failure");
	});
});
