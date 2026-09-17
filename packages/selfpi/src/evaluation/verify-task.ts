import { readFile } from "node:fs/promises";
import path from "node:path";

export interface ExactFileVerifier {
	readonly type: "exact_file";
	readonly path: string;
	readonly expectedContent: string;
}

export interface EvaluationTask {
	readonly id: string;
	readonly verifier: ExactFileVerifier;
}

export interface VerificationResult {
	readonly taskId: string;
	readonly verifiedCompletion: boolean;
	readonly reason: "artifact_missing" | "artifact_mismatch" | "verified";
}

export async function verifyEvaluationTask(
	task: EvaluationTask,
	workspaceDirectory: string,
): Promise<VerificationResult> {
	let actualContent: string;
	try {
		actualContent = await readFile(path.join(workspaceDirectory, task.verifier.path), "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return Object.freeze({
				taskId: task.id,
				verifiedCompletion: false,
				reason: "artifact_missing",
			});
		}
		throw error;
	}

	if (actualContent !== task.verifier.expectedContent) {
		return Object.freeze({
			taskId: task.id,
			verifiedCompletion: false,
			reason: "artifact_mismatch",
		});
	}

	return Object.freeze({
		taskId: task.id,
		verifiedCompletion: true,
		reason: "verified",
	});
}
