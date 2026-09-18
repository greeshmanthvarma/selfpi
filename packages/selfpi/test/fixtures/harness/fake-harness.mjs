import { writeFile } from "node:fs/promises";
import path from "node:path";

const workspaceDirectory = process.argv[2];
if (!workspaceDirectory) {
	throw new Error("Expected a workspace directory argument.");
}

await writeFile(path.join(workspaceDirectory, "answer.txt"), "Configuration file: src/settings.ts\n", "utf8");

process.stdout.write(
	JSON.stringify({
		transcript: [
			{ type: "assistant", content: "I will inspect the repository settings." },
			{
				type: "tool_result",
				toolName: "read",
				isError: true,
				content: "src/config.ts does not exist",
			},
			{ type: "assistant", content: "The configuration is in src/settings.ts." },
		],
		usage: { inputTokens: 12, outputTokens: 8 },
		perturbation: {
			version: 1,
			fired: true,
			toolCallSequence: 1,
			toolCallId: "read-1",
			path: "src/config.ts",
			error: "ENOENT src/config.ts",
			subsequentMatchingReadSuccesses: 1,
			repeatedIdenticalFailures: 0,
		},
	}),
);
process.stderr.write("fake harness completed\n");
