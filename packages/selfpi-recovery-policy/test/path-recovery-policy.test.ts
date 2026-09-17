import { describe, expect, it } from "vitest";
import { applyPathRecoveryPolicy, type PathRecoveryInput } from "../src/index.ts";

describe("path recovery policy", () => {
	it("returns no intervention for successful tools, non-read tools, and failed reads", () => {
		const inputs: readonly PathRecoveryInput[] = [
			{
				toolName: "read",
				args: { path: "src/config.ts" },
				content: [{ type: "text", text: "configuration contents" }],
				isError: false,
			},
			{
				toolName: "bash",
				args: { command: "exit 1" },
				content: [{ type: "text", text: "command failed" }],
				isError: true,
			},
			{
				toolName: "read",
				args: { path: "src/config.ts" },
				content: [{ type: "text", text: "src/config.ts does not exist" }],
				isError: true,
			},
		];

		expect(inputs.map((input) => applyPathRecoveryPolicy(input))).toEqual([undefined, undefined, undefined]);
	});
});
