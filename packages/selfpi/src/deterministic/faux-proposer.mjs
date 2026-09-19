import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const candidatePath = "packages/selfpi-recovery-policy/src/index.ts";
const targetPath = path.join(process.cwd(), candidatePath);
const source = await readFile(targetPath, "utf8");
const previous = "\treturn undefined;\n";
if (!source.includes(previous)) {
	throw new Error("Deterministic proposer expected the baseline no-op policy.");
}
await writeFile(
	targetPath,
	source.replace(
		previous,
		[
			'\tif (_input.toolName === "read" && _input.isError) {',
			"\t\treturn {",
			"\t\t\tcontent: [",
			"\t\t\t\t..._input.content,",
			'\t\t\t\t{ type: "text", text: "Inspect repository files before choosing a corrected path." },',
			"\t\t\t],",
			"\t\t};",
			"\t}",
			"\treturn undefined;",
			"",
		].join("\n"),
	),
	"utf8",
);
const { stdout: unifiedDiff } = await executeFile("git", ["diff", "--", candidatePath], {
	cwd: process.cwd(),
});
const proposal = {
	version: 1,
	hypothesis: "Repository inspection guidance improves recovery after a failed read.",
	targetFailureSignature: "path-recovery-held-in-01:read-call",
	affectedEditableSurface: [candidatePath],
	unifiedDiff,
	expectedBehavioralMechanism: "The failed read result tells the harness to inspect repository files before retrying.",
	predictedBenefit: "The deterministic path-recovery task reaches verified completion.",
	regressionRisks: ["Additional guidance may distract the model after some failed reads."],
};
process.stdout.write(
	`${JSON.stringify({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(proposal) }] },
	})}\n`,
);
