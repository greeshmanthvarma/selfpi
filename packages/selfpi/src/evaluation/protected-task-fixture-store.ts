import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { RegisteredTask } from "../config/load-supervised-runtime.ts";

const executeFile = promisify(execFile);
const SELFPI_CORPUS_URL_PREFIX = "selfpi-corpus:";

function resolveRepositoryCloneUrl(url: string): string {
	if (!url.startsWith(SELFPI_CORPUS_URL_PREFIX)) {
		return url;
	}
	const protectedRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../protected");
	const relative = url.slice(SELFPI_CORPUS_URL_PREFIX.length);
	// New corpora encode the corpus directory in the URL
	// (selfpi-corpus:tool-code-corpus-v1/repositories/...).
	// Legacy path-recovery URLs omit it (selfpi-corpus:repositories/...).
	if (relative.startsWith("path-recovery-corpus-v1/") || relative.startsWith("tool-code-corpus-v1/")) {
		return path.join(protectedRoot, relative);
	}
	return path.join(protectedRoot, "path-recovery-corpus-v1", relative);
}

export interface MaterializeProtectedTaskFixtureInput {
	readonly protectedRoot: string;
	readonly registryId: string;
	readonly task: RegisteredTask;
}

export interface MaterializedTaskFixture {
	readonly registryId: string;
	readonly taskId: string;
	readonly repositoryDirectory: string;
	readonly commit: string;
}

function assertSafeSegment(value: string, name: string): void {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) {
		throw new Error(`${name} is invalid.`);
	}
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function readCommit(repositoryDirectory: string): Promise<string> {
	const result = await executeFile("git", ["rev-parse", "HEAD"], { cwd: repositoryDirectory });
	return result.stdout.trim();
}

export async function materializeProtectedTaskFixture(
	input: MaterializeProtectedTaskFixtureInput,
): Promise<MaterializedTaskFixture> {
	assertSafeSegment(input.registryId, "Task registry ID");
	assertSafeSegment(input.task.id, "Task ID");
	if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.task.repository.commit)) {
		throw new Error("Task repository commit is invalid.");
	}
	const taskDirectory = path.join(input.protectedRoot, input.registryId, input.task.id);
	const repositoryDirectory = path.join(taskDirectory, "repository");
	const result = Object.freeze({
		registryId: input.registryId,
		taskId: input.task.id,
		repositoryDirectory,
		commit: input.task.repository.commit,
	});
	try {
		await access(repositoryDirectory);
		if ((await readCommit(repositoryDirectory)) === input.task.repository.commit) {
			return result;
		}
		// Registry commit moved (corpus regen); drop the stale checkout and rematerialize.
		await rm(taskDirectory, { recursive: true, force: true });
	} catch (error) {
		if (!isNotFound(error)) throw error;
	}

	await mkdir(taskDirectory, { recursive: true });
	const stagingDirectory = await mkdtemp(path.join(taskDirectory, ".materializing-"));
	try {
		await executeFile("git", [
			"clone",
			"--quiet",
			"--no-checkout",
			resolveRepositoryCloneUrl(input.task.repository.url),
			stagingDirectory,
		]);
		await executeFile("git", ["checkout", "--quiet", "--detach", input.task.repository.commit], {
			cwd: stagingDirectory,
		});
		if ((await readCommit(stagingDirectory)) !== input.task.repository.commit) {
			throw new Error(`Materialized task fixture ${input.task.id} does not match its registered commit.`);
		}
		await executeFile("git", ["remote", "remove", "origin"], { cwd: stagingDirectory });
		await rename(stagingDirectory, repositoryDirectory);
		return result;
	} catch (error) {
		await rm(stagingDirectory, { recursive: true, force: true });
		throw error;
	}
}
