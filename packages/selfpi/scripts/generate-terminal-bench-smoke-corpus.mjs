#!/usr/bin/env node
/**
 * Build a SelfPi-protected Terminal-Bench smoke corpus from a local Harbor export.
 *
 * Usage:
 *   node packages/selfpi/scripts/generate-terminal-bench-smoke-corpus.mjs \
 *     --source /tmp/tb-download/terminal-bench-2-1
 *
 * SelfPi remains the eval harness. This only vendors adapted TB task trees
 * (instruction + env files + tests) with /app remapped to workspace-relative paths.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
	cp,
	mkdir,
	readFile,
	readdir,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const corpusRoot = path.join(packageRoot, "protected/terminal-bench-smoke-v1");

const SMOKE_TASKS = Object.freeze([
	{ id: "sqlite-db-truncate", set: "held_in" },
	{ id: "db-wal-recovery", set: "held_in" },
	// Prefer a task present in local Harbor cache; large-scale is hard enough as held-out.
	{ id: "large-scale-text-editing", set: "held_out" },
]);

function parseArgs(argv) {
	let source;
	for (let index = 0; index < argv.length; index += 1) {
		if (argv[index] === "--source") {
			source = argv[index + 1];
			index += 1;
		}
	}
	if (source === undefined) {
		throw new Error("Missing --source <harbor-export-dir>/terminal-bench-2-1");
	}
	return { source };
}

function rewriteAppPaths(text) {
	return text.replaceAll("/app/", "./").replaceAll("/app", ".");
}

function digestJson(value) {
	return `sha256:${createHash("sha256").update(`${JSON.stringify(value)}\n`).digest("hex")}`;
}

async function writeGitBundle(taskWorkspace, bundlePath) {
	const gitEnv = { ...process.env, GIT_TEMPLATE_DIR: "" };
	// Prefer a bare git-dir: some sandboxes deny creating nested `.git/` directories.
	const stagingRoot = path.join(packageRoot, ".tmp-tb-git-staging");
	const bareGit = path.join(stagingRoot, `${path.basename(taskWorkspace)}.git`);
	await rm(stagingRoot, { recursive: true, force: true });
	await mkdir(bareGit, { recursive: true });
	execFileSync("git", ["-c", "init.templateDir=", "init", "--bare", "--quiet", bareGit], { env: gitEnv });
	const git = (args) =>
		execFileSync(
			"git",
			["--git-dir", bareGit, "--work-tree", taskWorkspace, "-c", "core.hooksPath=/dev/null", ...args],
			{ env: gitEnv },
		);
	git(["add", "-A"]);
	git([
		"-c",
		"user.name=selfpi",
		"-c",
		"user.email=selfpi@local",
		"commit",
		"--quiet",
		"-m",
		"terminal-bench smoke task",
	]);
	const commit = git(["rev-parse", "HEAD"]).toString("utf8").trim();
	await mkdir(path.dirname(bundlePath), { recursive: true });
	const stagingBundle = path.join(stagingRoot, `${path.basename(bundlePath)}.partial`);
	git(["bundle", "create", stagingBundle, "HEAD"]);
	await cp(stagingBundle, bundlePath);
	await rm(stagingRoot, { recursive: true, force: true });
	return commit;
}

/** Harbor cache nests tasks under a content hash: taskId/<hash>/{instruction,environment,tests}. */
async function resolveTaskUpstream(sourceRoot, taskId) {
	const direct = path.join(sourceRoot, taskId);
	await stat(direct);
	if (await exists(path.join(direct, "instruction.md"))) {
		return direct;
	}
	const children = await readdir(direct);
	for (const child of children) {
		const candidate = path.join(direct, child);
		if (await exists(path.join(candidate, "instruction.md"))) {
			return candidate;
		}
	}
	throw new Error(`Terminal-Bench task ${taskId} is missing instruction.md under ${direct}`);
}

async function exists(filePath) {
	try {
		await stat(filePath);
		return true;
	} catch {
		return false;
	}
}

async function packTask(sourceRoot, task) {
	const upstream = await resolveTaskUpstream(sourceRoot, task.id);
	const staging = path.join(corpusRoot, ".staging", task.id);
	await rm(staging, { recursive: true, force: true });
	await mkdir(staging, { recursive: true });

	const instruction = rewriteAppPaths(await readFile(path.join(upstream, "instruction.md"), "utf8"));
	await writeFile(path.join(staging, "instruction.md"), instruction, "utf8");

	const envDir = path.join(upstream, "environment");
	for (const name of await readdir(envDir)) {
		if (name === "Dockerfile" || name === "tests") continue;
		const sourcePath = path.join(envDir, name);
		const info = await stat(sourcePath);
		if (info.isFile()) {
			await cp(sourcePath, path.join(staging, name));
		}
	}

	await mkdir(path.join(staging, "tests"), { recursive: true });
	for (const name of await readdir(path.join(upstream, "tests"))) {
		const sourcePath = path.join(upstream, "tests", name);
		const info = await stat(sourcePath);
		if (!info.isFile()) continue;
		if (name === "test.sh") continue;
		const content = rewriteAppPaths(await readFile(sourcePath, "utf8"));
		await writeFile(path.join(staging, "tests", name), content, "utf8");
	}

	await writeFile(
		path.join(staging, "tests/test.sh"),
		[
			"#!/bin/bash",
			"set +e",
			"mkdir -p logs/verifier",
			"uvx -p 3.13 -w pytest==8.4.1 pytest tests/test_outputs.py -q",
			"status=$?",
			"if [ \"$status\" -eq 0 ]; then",
			"  echo 1 > logs/verifier/reward.txt",
			"else",
			"  echo 0 > logs/verifier/reward.txt",
			"fi",
			"exit 0",
			"",
		].join("\n"),
		"utf8",
	);

	const bundlePath = path.join(corpusRoot, "repositories", `${task.id}.bundle`);
	const commit = await writeGitBundle(staging, bundlePath);

	const verifier = {
		version: 1,
		id: task.id,
		verifier: {
			type: "shell_reward",
			testScript: "tests/test.sh",
			rewardDirectory: "logs/verifier",
			rewardFileName: "reward.txt",
		},
	};
	const verifierSource = `${JSON.stringify(verifier, null, "\t")}\n`;
	const verifierDigest = `sha256:${createHash("sha256").update(verifierSource).digest("hex")}`;
	await mkdir(path.join(corpusRoot, "protected-verifiers"), { recursive: true });
	await writeFile(path.join(corpusRoot, "protected-verifiers", `${task.id}.json`), verifierSource, "utf8");

	return {
		id: task.id,
		set: task.set,
		repository: {
			url: `selfpi-corpus:terminal-bench-smoke-v1/repositories/${task.id}.bundle`,
			commit,
		},
		input: instruction.trim(),
		verifier: {
			id: task.id,
			digest: verifierDigest,
		},
	};
}

async function main() {
	const { source } = parseArgs(process.argv.slice(2));
	await rm(corpusRoot, { recursive: true, force: true });
	await mkdir(path.join(corpusRoot, "repositories"), { recursive: true });

	const tasks = [];
	for (const task of SMOKE_TASKS) {
		tasks.push(await packTask(source, task));
	}

	const heldIn = tasks.filter((task) => task.set === "held_in");
	const heldOut = tasks.filter((task) => task.set === "held_out");
	const registry = {
		version: 1,
		id: "terminal-bench-smoke-registry-v1",
		heldIn,
		heldOut,
	};
	const registrySource = `${JSON.stringify(registry, null, "\t")}\n`;
	const digest = digestJson(registry);
	await writeFile(path.join(corpusRoot, "task-registry.json"), registrySource, "utf8");
	await writeFile(
		path.join(corpusRoot, "task-registry.metadata.json"),
		`${JSON.stringify(
			{
				version: 1,
				id: registry.id,
				digest,
				heldInTaskCount: heldIn.length,
				heldOutTaskCount: heldOut.length,
				source: "terminal-bench/terminal-bench-2-1",
				evalHarness: "selfpi",
			},
			null,
			"\t",
		)}\n`,
		"utf8",
	);
	await rm(path.join(corpusRoot, ".staging"), { recursive: true, force: true });
	process.stdout.write(`Wrote ${corpusRoot}\ndigest ${digest}\ntasks ${tasks.map((task) => task.id).join(", ")}\n`);
}

await main();
