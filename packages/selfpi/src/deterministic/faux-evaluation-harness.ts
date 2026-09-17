import { writeFile } from "node:fs/promises";
import path from "node:path";
import { applyPathRecoveryPolicy } from "../../../selfpi-recovery-policy/src/index.ts";

const workspaceDirectory = process.argv.at(-1);
const taskId = process.argv.at(-2);
if (workspaceDirectory === undefined || taskId === undefined) {
	throw new Error("Deterministic evaluation requires a task and workspace.");
}
const failedRead = {
	toolName: "read",
	args: { path: "src/config.ts" },
	content: [{ type: "text" as const, text: "src/config.ts does not exist" }],
	isError: true,
};
const decision = applyPathRecoveryPolicy(failedRead);
const preservedSuccess = taskId === "path-recovery-held-out-01";
if (preservedSuccess || decision !== undefined) {
	await writeFile(path.join(workspaceDirectory, "answer.txt"), "Configuration file: src/settings.ts\n", "utf8");
}
process.stdout.write(
	JSON.stringify({
		transcript: [
			{ type: "assistant", content: "I will inspect the expected configuration path." },
			{ type: "tool_result", toolName: "read", isError: true, content: failedRead.content[0].text },
			...(decision === undefined && !preservedSuccess
				? []
				: [
						{
							type: "assistant",
							content:
								decision?.content.map((part) => part.text).join("\n") ??
								"The naturalistic task completed without recovery guidance.",
						},
					]),
		],
		usage: { inputTokens: 12, outputTokens: decision === undefined && !preservedSuccess ? 3 : 8 },
	}),
);
