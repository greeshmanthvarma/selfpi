process.stdout.write(
	JSON.stringify({
		transcript: [
			{ type: "assistant", content: "I will inspect the expected configuration path." },
			{
				type: "tool_result",
				toolName: "read",
				isError: true,
				content: "src/config.ts does not exist",
			},
		],
		usage: { inputTokens: 12, outputTokens: 3 },
	}),
);
process.stderr.write("failing fake harness completed\n");
