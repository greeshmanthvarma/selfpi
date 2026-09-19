const valueAfter = (flag) => process.argv[process.argv.indexOf(flag) + 1];
const output = {
	hypothesis: `${valueAfter("--provider")}/${valueAfter("--model")}:${valueAfter("--thinking")}`,
	promptIncludesEvidence: process.argv.at(-1).includes("Evidence bundle:"),
};
process.stdout.write(
	`${JSON.stringify({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(output) }] },
	})}\n`,
);
