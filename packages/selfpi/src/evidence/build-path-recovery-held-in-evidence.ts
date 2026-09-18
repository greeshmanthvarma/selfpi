import type { RegisteredTask } from "../config/load-supervised-runtime.ts";
import type { VerificationResult } from "../evaluation/verify-task.ts";
import type { RedactedRepresentativeTrace } from "./build-sealed-evidence-bundle.ts";
import type { PathRecoveryFailureSignature } from "./extract-path-recovery-failures.ts";

export interface PathRecoveryHeldInEvidence {
	readonly heldInFailures: readonly PathRecoveryFailureSignature[];
	readonly redactedRepresentativeTraces: readonly RedactedRepresentativeTrace[];
	readonly heldInVerifierOutcomes: readonly VerificationResult[];
}

/**
 * Build sealed held-in evidence that teaches the recovery mechanism and the real
 * PathRecoveryInput shape without prescribing a concrete policy implementation.
 */
export function buildPathRecoveryHeldInEvidence(heldInTasks: readonly RegisteredTask[]): PathRecoveryHeldInEvidence {
	const failingTasks = heldInTasks.filter(
		(task) => task.perturbation !== undefined && task.perturbation.path.length > 0,
	);
	const heldInFailures = failingTasks.map((task, index) => {
		const baitPath = task.perturbation?.path ?? "";
		const errorText = task.perturbation?.error ?? `${baitPath} does not exist`;
		return Object.freeze({
			version: 1 as const,
			taskId: task.id,
			verifiedCompletion: false,
			verification: Object.freeze({
				verifiedCompletion: false,
				reason: "artifact_missing" as const,
			}),
			toolCallId: `supervised-read-${String(index + 1)}`,
			toolName: "read" as const,
			arguments: Object.freeze({ path: baitPath }),
			errorContent: errorText,
			sourceEntryIds: Object.freeze({
				toolCall: `supervised-call-${String(index + 1)}`,
				toolResult: `supervised-result-${String(index + 1)}`,
			}),
			// No productive follow-up tools: the agent did not recover after the baited read.
			subsequentToolCalls: Object.freeze([]),
		});
	});

	const redactedRepresentativeTraces = failingTasks.map((task) => {
		const baitPath = task.perturbation?.path ?? "";
		const errorText = task.perturbation?.error ?? `${baitPath} does not exist`;
		const observedInput = {
			toolName: "read",
			args: { path: baitPath },
			content: [{ type: "text", text: errorText }],
			isError: true,
		};
		return Object.freeze({
			taskId: task.id,
			entries: Object.freeze([
				Object.freeze({
					role: "task",
					content: task.input,
				}),
				Object.freeze({
					role: "tool",
					content: `read ${baitPath}: ${errorText}`,
				}),
				Object.freeze({
					role: "policy_hook",
					content: `Observed PathRecoveryInput at the failed-read hook: ${JSON.stringify(observedInput)}. When this hook runs, content is always a non-empty text-part array; it is never undefined.`,
				}),
				Object.freeze({
					role: "outcome",
					content:
						"verifiedCompletion=false reason=artifact_missing. Recovery is scored only when a baited read fails and the agent still produces a verified completion. The editable policy may only rewrite failed read tool_result content; it cannot add tools or change the verifier.",
				}),
				Object.freeze({
					role: "gap",
					content: `After the failed read of ${baitPath}, subsequentToolCalls were empty and answer.txt was not produced.`,
				}),
			]),
		});
	});

	const heldInVerifierOutcomes = failingTasks.map((task) =>
		Object.freeze({
			taskId: task.id,
			verifiedCompletion: false,
			reason: "artifact_missing" as const,
		}),
	);

	return Object.freeze({
		heldInFailures: Object.freeze(heldInFailures),
		redactedRepresentativeTraces: Object.freeze(redactedRepresentativeTraces),
		heldInVerifierOutcomes: Object.freeze(heldInVerifierOutcomes),
	});
}
