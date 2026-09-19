import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

async function runGit(repositoryDirectory: string, args: readonly string[], standardInput?: string): Promise<void> {
	const child = spawn("git", [...args], {
		cwd: repositoryDirectory,
		stdio: [standardInput === undefined ? "ignore" : "pipe", "ignore", "pipe"],
	});
	const stderrChunks: Buffer[] = [];
	child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
	if (standardInput !== undefined) child.stdin?.end(standardInput);
	const exitCode = await new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
	if (exitCode !== 0) {
		throw new Error(Buffer.concat(stderrChunks).toString("utf8").trim() || `Git exited with ${String(exitCode)}.`);
	}
}

export async function withCandidateWorktree<T>(input: {
	readonly repositoryDirectory: string;
	readonly worktreeRoot: string;
	readonly baselineCommit: string;
	readonly unifiedDiff?: string;
	readonly run: (directory: string) => Promise<T>;
}): Promise<T> {
	await mkdir(input.worktreeRoot, { recursive: true });
	const directory = path.join(input.worktreeRoot, randomUUID());
	let created = false;
	try {
		await runGit(input.repositoryDirectory, ["worktree", "add", "--detach", directory, input.baselineCommit]);
		created = true;
		if (input.unifiedDiff !== undefined) {
			await runGit(directory, ["apply", "--whitespace=nowarn", "-"], input.unifiedDiff);
		}
		return await input.run(directory);
	} finally {
		if (created) {
			await runGit(input.repositoryDirectory, ["worktree", "remove", "--force", directory]);
		} else {
			await rm(directory, { recursive: true, force: true });
		}
	}
}
