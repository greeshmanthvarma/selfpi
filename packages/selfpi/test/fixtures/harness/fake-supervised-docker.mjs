import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const args = process.argv.slice(2);
const statePath = process.env.SELFPI_FAKE_DOCKER_STATE;
if (statePath === undefined || statePath.length === 0) {
	throw new Error("SELFPI_FAKE_DOCKER_STATE is required.");
}

async function readState() {
	try {
		return JSON.parse(await readFile(statePath, "utf8"));
	} catch {
		return { labelsByDigest: {}, calls: [] };
	}
}

async function writeState(state) {
	await mkdir(path.dirname(statePath), { recursive: true });
	await writeFile(statePath, `${JSON.stringify(state)}\n`, "utf8");
}

function mountSource(dockerArgs, destination) {
	const mount = dockerArgs.find((value) => value.startsWith("type=bind,") && value.includes(`dst=${destination}`));
	if (mount === undefined) return undefined;
	const match = /(?:^|,)src=([^,]+)/.exec(mount);
	return match?.[1];
}

function envValue(dockerArgs, key) {
	const index = dockerArgs.findIndex((value) => value === "--env");
	for (let i = 0; i < dockerArgs.length; i += 1) {
		if (dockerArgs[i] !== "--env") continue;
		const assignment = dockerArgs[i + 1];
		if (assignment === key) return process.env[key];
		if (typeof assignment === "string" && assignment.startsWith(`${key}=`)) {
			return assignment.slice(key.length + 1);
		}
	}
	return undefined;
}

function emitAssistant(value) {
	process.stdout.write(
		`${JSON.stringify({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(value) }] },
		})}\n`,
	);
}

const state = await readState();
state.calls.push(args);
await writeState(state);

if (args[0] === "network" && args[1] === "create") {
	process.exit(0);
}
if (args[0] === "network" && args[1] === "rm") {
	process.exit(0);
}
if (args[0] === "rm") {
	process.exit(0);
}

if (args[0] === "build") {
	const iidfileIndex = args.indexOf("--iidfile");
	const iidfile = iidfileIndex >= 0 ? args[iidfileIndex + 1] : undefined;
	if (iidfile === undefined) throw new Error("Fake docker build requires --iidfile.");
	const labels = {};
	for (let i = 0; i < args.length; i += 1) {
		if (args[i] !== "--label") continue;
		const assignment = args[i + 1];
		if (typeof assignment !== "string") continue;
		const separator = assignment.indexOf("=");
		if (separator <= 0) continue;
		labels[assignment.slice(0, separator)] = assignment.slice(separator + 1);
	}
	const imageDigest = `sha256:${"b".repeat(64)}`;
	state.labelsByDigest[imageDigest] = labels;
	await writeState(state);
	await writeFile(iidfile, `${imageDigest}\n`, "utf8");
	process.exit(0);
}

if (args[0] === "image" && args[1] === "inspect") {
	const digest = args.at(-1);
	const labels = state.labelsByDigest[digest] ?? {};
	process.stdout.write(`${JSON.stringify(labels)}\n`);
	process.exit(0);
}

if (args[0] === "run") {
	if (args.includes("works.selfpi.role=gateway-proxy") || args.includes("alpine/socat:1.8.0.0")) {
		process.stdout.write("proxy-container\n");
		process.exit(0);
	}
	if (args.includes("--detach")) {
		process.stdout.write("proxy-container\n");
		process.exit(0);
	}

	const workspace = mountSource(args, "/workspace");
	const modeIndex = args.indexOf("--mode");
	const isPiProcess = modeIndex >= 0 && args[modeIndex + 1] === "json";
	if (isPiProcess) {
		const toolsIndex = args.indexOf("--tools");
		const tools = toolsIndex >= 0 ? args[toolsIndex + 1] : "";
		if (typeof tools === "string" && tools.includes("write")) {
			if (workspace === undefined) throw new Error("Fake proposer requires a workspace mount.");
			const candidatePath = "packages/selfpi-recovery-policy/src/index.ts";
			const targetPath = path.join(workspace, candidatePath);
			const source = await readFile(targetPath, "utf8");
			const previous = "\treturn undefined;\n";
			if (!source.includes(previous)) {
				throw new Error("Fake proposer expected the baseline no-op policy.");
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
				cwd: workspace,
			});
			emitAssistant({
				version: 1,
				hypothesis: "Repository inspection guidance improves recovery after a failed read.",
				targetFailureSignature: "held-in-1:read",
				affectedEditableSurface: [candidatePath],
				unifiedDiff,
				expectedBehavioralMechanism:
					"The failed read result tells the harness to inspect repository files before retrying.",
				predictedBenefit: "Held-in path-recovery tasks reach verified completion.",
				regressionRisks: ["Additional guidance may distract the model after some failed reads."],
			});
			process.exit(0);
		}
		emitAssistant({
			decision: "approve_for_evaluation",
			hypothesisAlignment: "aligned",
			risks: [],
			violations: [],
		});
		process.exit(0);
	}

	if (workspace === undefined) throw new Error("Fake evaluation requires a workspace mount.");
	const variant = envValue(args, "SELFPI_VARIANT");
	const taskId = envValue(args, "SELFPI_TASK_ID");
	const heldOut = typeof taskId === "string" && taskId.includes("held-out");
	const complete = heldOut || variant === "candidate";
	if (complete) {
		await writeFile(path.join(workspace, "answer.txt"), "Configuration file: src/settings.ts\n", "utf8");
	}
	const perturbation =
		typeof taskId === "string" && taskId.includes("held-in")
			? {
					version: 1,
					fired: true,
					toolCallSequence: 1,
					toolCallId: "read-1",
					path: "src/config.ts",
					error: "ENOENT src/config.ts",
					subsequentMatchingReadSuccesses: complete ? 1 : 0,
					repeatedIdenticalFailures: 0,
				}
			: { version: 1, fired: false };
	process.stdout.write(
		JSON.stringify({
			transcript: [
				{ type: "assistant", content: "I will inspect the repository settings." },
				{ type: "tool_result", toolName: "read", isError: true, content: "src/config.ts does not exist" },
				...(complete
					? [{ type: "assistant", content: "The configuration is in src/settings.ts." }]
					: []),
			],
			usage: { inputTokens: 12, outputTokens: complete ? 8 : 3 },
			perturbation,
		}),
	);
	process.exit(0);
}

process.stderr.write(`Unhandled fake docker args: ${args.join(" ")}\n`);
process.exit(1);
