import { describe, expect, it } from "vitest";
import { applyPathRecoveryPolicy, type PathRecoveryInput } from "../src/index.ts";

describe("path recovery policy", () => {
	it("preserves successful tools and failures outside the editable recovery seam", () => {
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
		];

		expect(inputs.map((input) => applyPathRecoveryPolicy(input))).toEqual([undefined, undefined]);
	});
});
