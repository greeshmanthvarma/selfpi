import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

const corpusRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../protected/tool-code-corpus-v1");

/**
 * @typedef {{
 *   toolName: "read" | "bash" | "edit" | "grep" | "write" | "find" | "ls";
 *   arguments: Record<string, unknown>;
 *   errorContent: string;
 *   mechanism: string;
 * }} NaturalFailure
 */

/**
 * @typedef {{
 *   id: string;
 *   set: "held_in" | "held_out";
 *   input: string;
 *   files: Record<string, string>;
 *   executable?: string[];
 *   verifierPath: string;
 *   expectedContent: string;
 *   naturalFailure: NaturalFailure;
 * }} TaskSpec
 */

function buildDeepLog(needleLine) {
	const lines = [];
	for (let index = 1; index <= 2500; index += 1) {
		lines.push(index === needleLine ? `NEEDLE_TOKEN=${needleLine}` : `noise line ${String(index)}`);
	}
	return `${lines.join("\n")}\n`;
}

/** @type {TaskSpec[]} */
const tasks = [
	{
		id: "tool-code-held-in-01",
		set: "held_in",
		input:
			'Find the runtime configuration module. Write exactly one line to answer.txt in this form: "Configuration file: <repository-relative-path>".',
		files: {
			"README.md": "Runtime configuration lives at config/app.json.\n",
			"settings/runtime.json": '{"mode":"held-in-01"}\n',
		},
		verifierPath: "answer.txt",
		expectedContent: "Configuration file: settings/runtime.json\n",
		naturalFailure: {
			toolName: "read",
			arguments: { path: "config/app.json" },
			errorContent: "ENOENT: no such file or directory, access 'config/app.json'",
			mechanism: "read returns opaque missing-path errors without nearby-path guidance",
		},
	},
	{
		id: "tool-code-held-in-02",
		set: "held_in",
		input:
			"Run ./scripts/probe.sh. It exits non-zero and prints ERROR_CODE on stderr. Write exactly that ERROR_CODE value followed by a newline to answer.txt.",
		files: {
			"README.md": "probe helper\n",
			"scripts/probe.sh":
				"#!/bin/sh\nCODE=$(printf 'dyn-%s' \"$(wc -c < README.md | tr -d ' ')\" )\necho \"ERROR_CODE=$CODE\" >&2\nexit 1\n",
		},
		executable: ["scripts/probe.sh"],
		verifierPath: "answer.txt",
		expectedContent: "dyn-13\n",
		naturalFailure: {
			toolName: "bash",
			arguments: { command: "./scripts/probe.sh" },
			errorContent: "ERROR_CODE=dyn-13\n\nCommand exited with code 1",
			mechanism: "bash non-zero exits must keep stderr actionable after status appending and truncation",
		},
	},
	{
		id: "tool-code-held-in-03",
		set: "held_in",
		input:
			"logs/app.log contains NEEDLE_TOKEN=<digits> once, past the default read truncation window. Write exactly that full NEEDLE_TOKEN=... line followed by a newline to answer.txt.",
		files: {
			"logs/app.log": buildDeepLog(2400),
			"README.md": "Application logs are under logs/.\n",
		},
		verifierPath: "answer.txt",
		expectedContent: "NEEDLE_TOKEN=2400\n",
		naturalFailure: {
			toolName: "read",
			arguments: { path: "logs/app.log" },
			errorContent:
				"[truncated: showing first ~2000 lines / 50KB; use offset/limit or open the saved full output]",
			mechanism: "large-file read truncation can hide the only task-relevant line without clear continuation cues",
		},
	},
	{
		id: "tool-code-held-in-04",
		set: "held_in",
		input:
			'In src/flags.ts, change only the production MODE assignment from "draft" to "ready". Leave the test MODE assignment unchanged.',
		files: {
			"src/flags.ts":
				'export const test = { MODE: "draft" };\nexport const production = { MODE: "draft" };\n',
			"README.md": "Edit production MODE only.\n",
		},
		verifierPath: "src/flags.ts",
		expectedContent: 'export const test = { MODE: "draft" };\nexport const production = { MODE: "ready" };\n',
		naturalFailure: {
			toolName: "edit",
			arguments: {
				path: "src/flags.ts",
				edits: [{ oldText: 'MODE: "draft"', newText: 'MODE: "ready"' }],
			},
			errorContent: "Could not edit file: src/flags.ts. oldText matched multiple times.",
			mechanism: "edit uniqueness failures need precise match-location feedback so agents can narrow oldText",
		},
	},
	{
		id: "tool-code-held-out-01",
		set: "held_out",
		input:
			'Find the service configuration module. Write exactly one line to answer.txt in this form: "Configuration file: <repository-relative-path>".',
		files: {
			"docs/setup.md": "Service configuration is service/config.json.\n",
			"service/runtime/settings.json": '{"region":"held-out-01"}\n',
		},
		verifierPath: "answer.txt",
		expectedContent: "Configuration file: service/runtime/settings.json\n",
		naturalFailure: {
			toolName: "read",
			arguments: { path: "service/config.json" },
			errorContent: "ENOENT: no such file or directory, access 'service/config.json'",
			mechanism: "read returns opaque missing-path errors without nearby-path guidance",
		},
	},
	{
		id: "tool-code-held-out-02",
		set: "held_out",
		input:
			"Run ./bin/healthcheck.sh. It exits non-zero and prints ERROR_CODE on stderr. Write exactly that ERROR_CODE value followed by a newline to answer.txt.",
		files: {
			"VERSION": "1\n",
			"bin/healthcheck.sh":
				"#!/bin/sh\nCODE=$(printf 'hc-%s' \"$(wc -c < VERSION | tr -d ' ')\" )\necho \"ERROR_CODE=$CODE\" >&2\nexit 2\n",
		},
		executable: ["bin/healthcheck.sh"],
		verifierPath: "answer.txt",
		expectedContent: "hc-2\n",
		naturalFailure: {
			toolName: "bash",
			arguments: { command: "./bin/healthcheck.sh" },
			errorContent: "ERROR_CODE=hc-2\n\nCommand exited with code 2",
			mechanism: "bash non-zero exits must keep stderr actionable after status appending and truncation",
		},
	},
	{
		id: "tool-code-held-out-03",
		set: "held_out",
		input:
			"data/events.log contains NEEDLE_TOKEN=<digits> once, past the default read truncation window. Write exactly that full NEEDLE_TOKEN=... line followed by a newline to answer.txt.",
		files: {
			"data/events.log": buildDeepLog(2350),
			"NOTES.md": "Event logs are under data/.\n",
		},
		verifierPath: "answer.txt",
		expectedContent: "NEEDLE_TOKEN=2350\n",
		naturalFailure: {
			toolName: "read",
			arguments: { path: "data/events.log" },
			errorContent:
				"[truncated: showing first ~2000 lines / 50KB; use offset/limit or open the saved full output]",
			mechanism: "large-file read truncation can hide the only task-relevant line without clear continuation cues",
		},
	},
	{
		id: "tool-code-held-out-04",
		set: "held_out",
		input:
			'In config/modes.ts, change only the live MODE assignment from "beta" to "ga". Leave the sandbox MODE assignment unchanged.',
		files: {
			"config/modes.ts":
				'export const sandbox = { MODE: "beta" };\nexport const live = { MODE: "beta" };\n',
			"README.md": "Edit live MODE only.\n",
		},
		verifierPath: "config/modes.ts",
		expectedContent: 'export const sandbox = { MODE: "beta" };\nexport const live = { MODE: "ga" };\n',
		naturalFailure: {
			toolName: "edit",
			arguments: {
				path: "config/modes.ts",
				edits: [{ oldText: 'MODE: "beta"', newText: 'MODE: "ga"' }],
			},
			errorContent: "Could not edit file: config/modes.ts. oldText matched multiple times.",
			mechanism: "edit uniqueness failures need precise match-location feedback so agents can narrow oldText",
		},
	},
];

async function writeTree(root, files, executable = []) {
	for (const [relativePath, content] of Object.entries(files)) {
		const absolutePath = path.join(root, relativePath);
		await mkdir(path.dirname(absolutePath), { recursive: true });
		await writeFile(absolutePath, content, "utf8");
	}
	for (const relativePath of executable) {
		await chmod(path.join(root, relativePath), 0o755);
	}
}

async function createBundle(spec) {
	const work = await mkdtemp(path.join(tmpdir(), `${spec.id}-`));
	try {
		await writeTree(work, spec.files, spec.executable ?? []);
		await executeFile("git", ["-c", "init.defaultBranch=main", "init", "--quiet"], { cwd: work });
		await executeFile("git", ["-c", "core.hooksPath=/dev/null", "add", "."], { cwd: work });
		await executeFile(
			"git",
			[
				"-c",
				"core.hooksPath=/dev/null",
				"-c",
				"user.name=SelfPi Corpus",
				"-c",
				"user.email=selfpi-corpus@example.invalid",
				"commit",
				"--quiet",
				"-m",
				spec.id,
			],
			{ cwd: work },
		);
		const commit = (await executeFile("git", ["rev-parse", "HEAD"], { cwd: work })).stdout.trim();
		const bundlePath = path.join(corpusRoot, "repositories", `${spec.id}.bundle`);
		await mkdir(path.dirname(bundlePath), { recursive: true });
		await executeFile("git", ["bundle", "create", bundlePath, "HEAD"], { cwd: work });
		return commit;
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

async function main() {
	await rm(corpusRoot, { recursive: true, force: true });
	await mkdir(path.join(corpusRoot, "protected-verifiers"), { recursive: true });
	await mkdir(path.join(corpusRoot, "repositories"), { recursive: true });

	const registryTasks = [];
	/** @type {Record<string, NaturalFailure>} */
	const failureCatalog = {};

	for (const spec of tasks) {
		const commit = await createBundle(spec);
		const verifierSource = `${JSON.stringify({
			version: 1,
			id: spec.id,
			verifier: { type: "exact_file", path: spec.verifierPath, expectedContent: spec.expectedContent },
		})}\n`;
		const digest = `sha256:${createHash("sha256").update(verifierSource).digest("hex")}`;
		await writeFile(path.join(corpusRoot, "protected-verifiers", `${spec.id}.json`), verifierSource, "utf8");
		registryTasks.push({
			id: spec.id,
			set: spec.set,
			repository: {
				url: `selfpi-corpus:tool-code-corpus-v1/repositories/${spec.id}.bundle`,
				commit,
			},
			input: spec.input,
			verifier: { id: spec.id, digest },
		});
		failureCatalog[spec.id] = {
			version: 1,
			toolName: spec.naturalFailure.toolName,
			arguments: spec.naturalFailure.arguments,
			errorContent: spec.naturalFailure.errorContent,
			mechanism: spec.naturalFailure.mechanism,
		};
	}

	const registrySource = `${JSON.stringify(
		{ version: 1, id: "tool-code-registry-v1", tasks: registryTasks },
		null,
		2,
	)}\n`;
	const registryDigest = `sha256:${createHash("sha256").update(registrySource).digest("hex")}`;
	await writeFile(path.join(corpusRoot, "task-registry.json"), registrySource, "utf8");
	await writeFile(
		path.join(corpusRoot, "failure-catalog.json"),
		`${JSON.stringify({ version: 1, id: "tool-code-failure-catalog-v1", failures: failureCatalog }, null, 2)}\n`,
		"utf8",
	);
	await writeFile(
		path.join(corpusRoot, "task-registry.metadata.json"),
		`${JSON.stringify(
			{
				version: 1,
				id: "tool-code-registry-v1",
				digest: registryDigest,
				heldInTaskCount: tasks.filter((task) => task.set === "held_in").length,
				heldOutTaskCount: tasks.filter((task) => task.set === "held_out").length,
				content: "redacted",
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	process.stdout.write(`${registryDigest}\n`);
}

await main();
