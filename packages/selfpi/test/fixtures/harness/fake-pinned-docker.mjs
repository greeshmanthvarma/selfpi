import { writeFile } from "node:fs/promises";

const capturePath = process.argv[2];
if (!capturePath) throw new Error("Expected a capture path.");
await writeFile(capturePath, `${JSON.stringify(process.argv.slice(3))}\n`, "utf8");

const jsonl = [
	JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: JSON.stringify({ hypothesis: "pinned-image-proposal" }) }],
		},
	}),
	"",
].join("\n");
process.stdout.write(jsonl);
