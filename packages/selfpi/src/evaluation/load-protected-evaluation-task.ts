import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { EvaluationTask } from "../evaluation/verify-task.ts";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function loadProtectedEvaluationTask(input: {
	readonly rootDirectory: string;
	readonly verifierId: string;
	readonly expectedDigest: string;
	readonly taskId: string;
}): Promise<{ readonly digest: string; readonly task: EvaluationTask }> {
	const verifierPath = path.join(input.rootDirectory, "protected-verifiers", `${input.verifierId}.json`);
	const source = await readFile(verifierPath, "utf8");
	const digest = `sha256:${createHash("sha256").update(source).digest("hex")}`;
	if (digest !== input.expectedDigest) {
		throw new Error(`Protected verifier ${input.verifierId} digest does not match the task registry.`);
	}
	const value: unknown = JSON.parse(source);
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		value.id !== input.taskId ||
		!isRecord(value.verifier) ||
		value.verifier.type !== "exact_file" ||
		typeof value.verifier.path !== "string" ||
		typeof value.verifier.expectedContent !== "string"
	) {
		throw new Error(`Protected verifier ${input.verifierId} is invalid.`);
	}
	return Object.freeze({
		digest,
		task: Object.freeze({
			id: input.taskId,
			verifier: Object.freeze({
				type: "exact_file" as const,
				path: value.verifier.path,
				expectedContent: value.verifier.expectedContent,
			}),
		}),
	});
}
