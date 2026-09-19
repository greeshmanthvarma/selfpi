import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ExactFileVerifier {
	readonly type: "exact_file";
	readonly path: string;
	readonly expectedContent: string;
}

/**
 * Terminal-Bench-style verifier adapted to SelfPi workspaces.
 * Runs `testScript` (usually tests/test.sh) after remapping absolute
 * `/logs/verifier` paths into the workspace, then reads reward.txt.
 */
export interface ShellRewardVerifier {
	readonly type: "shell_reward";
	readonly testScript: string;
	/** Directory under the workspace that replaces `/logs/verifier`. */
	readonly rewardDirectory: string;
	readonly rewardFileName?: string;
	readonly timeoutMs?: number;
}

export type TaskVerifier = ExactFileVerifier | ShellRewardVerifier;

export interface EvaluationTask {
	readonly id: string;
	readonly verifier: TaskVerifier;
}

export interface VerificationResult {
	readonly taskId: string;
	readonly verifiedCompletion: boolean;
	readonly reason: "artifact_missing" | "artifact_mismatch" | "verified";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function verifyExactFile(
	taskId: string,
	verifier: ExactFileVerifier,
	workspaceDirectory: string,
): Promise<VerificationResult> {
	let actualContent: string;
	try {
		actualContent = await readFile(path.join(workspaceDirectory, verifier.path), "utf8");
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") {
			return Object.freeze({
				taskId,
				verifiedCompletion: false,
				reason: "artifact_missing",
			});
		}
		throw error;
	}

	if (actualContent !== verifier.expectedContent) {
		return Object.freeze({
			taskId,
			verifiedCompletion: false,
			reason: "artifact_mismatch",
		});
	}

	return Object.freeze({
		taskId,
		verifiedCompletion: true,
		reason: "verified",
	});
}

async function runAdaptedShellTest(input: {
	readonly workspaceDirectory: string;
	readonly testScript: string;
	readonly rewardDirectoryAbsolute: string;
	readonly timeoutMs: number;
}): Promise<void> {
	const sourceScript = await readFile(path.join(input.workspaceDirectory, input.testScript), "utf8");
	const adapted = sourceScript.replaceAll("/logs/verifier", input.rewardDirectoryAbsolute);
	const adaptedPath = path.join(input.workspaceDirectory, ".selfpi-adapted-test.sh");
	await writeFile(adaptedPath, adapted, "utf8");
	await new Promise<void>((resolve, reject) => {
		const child = spawn("bash", [adaptedPath], {
			cwd: input.workspaceDirectory,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, input.timeoutMs);
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", () => {
			clearTimeout(timer);
			if (timedOut) {
				reject(new Error(`Shell reward verifier timed out after ${String(input.timeoutMs)}ms.`));
				return;
			}
			// TB test.sh writes 0/1 reward on both pass and fail; non-zero exit is fine.
			resolve();
		});
	});
}

async function verifyShellReward(
	taskId: string,
	verifier: ShellRewardVerifier,
	workspaceDirectory: string,
): Promise<VerificationResult> {
	const rewardDirectoryAbsolute = path.join(workspaceDirectory, verifier.rewardDirectory);
	const rewardFileName = verifier.rewardFileName ?? "reward.txt";
	const rewardPath = path.join(rewardDirectoryAbsolute, rewardFileName);
	await mkdir(rewardDirectoryAbsolute, { recursive: true });
	try {
		await runAdaptedShellTest({
			workspaceDirectory,
			testScript: verifier.testScript,
			rewardDirectoryAbsolute,
			timeoutMs: verifier.timeoutMs ?? 120_000,
		});
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") {
			return Object.freeze({
				taskId,
				verifiedCompletion: false,
				reason: "artifact_missing",
			});
		}
		throw error;
	}

	let rewardRaw: string;
	try {
		rewardRaw = await readFile(rewardPath, "utf8");
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") {
			return Object.freeze({
				taskId,
				verifiedCompletion: false,
				reason: "artifact_missing",
			});
		}
		throw error;
	}

	const trimmed = rewardRaw.trim();
	if (trimmed === "1") {
		return Object.freeze({
			taskId,
			verifiedCompletion: true,
			reason: "verified",
		});
	}
	return Object.freeze({
		taskId,
		verifiedCompletion: false,
		reason: "artifact_mismatch",
	});
}

export async function verifyEvaluationTask(
	task: EvaluationTask,
	workspaceDirectory: string,
): Promise<VerificationResult> {
	if (task.verifier.type === "exact_file") {
		return verifyExactFile(task.id, task.verifier, workspaceDirectory);
	}
	if (task.verifier.type === "shell_reward") {
		return verifyShellReward(task.id, task.verifier, workspaceDirectory);
	}
	const _exhaustive: never = task.verifier;
	return _exhaustive;
}
