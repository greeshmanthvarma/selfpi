import type { RegisteredTask } from "../config/load-supervised-runtime.ts";
import type { ToolCodeNaturalFailure } from "../evaluation/tool-code-corpus.ts";
import type { VerificationResult } from "../evaluation/verify-task.ts";
import type { RedactedRepresentativeTrace } from "./build-sealed-evidence-bundle.ts";
import type { ToolFailureSignature } from "./extract-tool-failures.ts";

export interface ToolCodeHeldInEvidence {
	readonly heldInFailures: readonly ToolFailureSignature[];
	readonly redactedRepresentativeTraces: readonly RedactedRepresentativeTrace[];
	readonly heldInVerifierOutcomes: readonly VerificationResult[];
}

/**
 * Build sealed held-in evidence from natural tool-failure catalog entries.
 * Describes observed failure modes and mechanisms without prescribing a tools-code patch.
 */
export function buildToolCodeHeldInEvidence(
	heldInTasks: readonly RegisteredTask[],
	failureCatalog: Readonly<Record<string, ToolCodeNaturalFailure>>,
): ToolCodeHeldInEvidence {
	const failingTasks = heldInTasks.filter((task) => failureCatalog[task.id] !== undefined);
	const heldInFailures = failingTasks.map((task, index) => {
		const failure = failureCatalog[task.id] as ToolCodeNaturalFailure;
		return Object.freeze({
			version: 1 as const,
			taskId: task.id,
			verifiedCompletion: false,
			verification: Object.freeze({
				verifiedCompletion: false,
				reason: "artifact_missing" as const,
			}),
			toolCallId: `supervised-tool-${String(index + 1)}`,
			toolName: failure.toolName,
			arguments: Object.freeze({ ...failure.arguments }),
			errorContent: failure.errorContent,
			sourceEntryIds: Object.freeze({
				toolCall: `supervised-call-${String(index + 1)}`,
				toolResult: `supervised-result-${String(index + 1)}`,
			}),
			subsequentToolCalls: Object.freeze([]),
		});
	});

	const redactedRepresentativeTraces = failingTasks.map((task) => {
		const failure = failureCatalog[task.id] as ToolCodeNaturalFailure;
		const argsSummary = JSON.stringify(failure.arguments);
		return Object.freeze({
			taskId: task.id,
			entries: Object.freeze([
				Object.freeze({
					role: "task",
					content: task.input,
				}),
				Object.freeze({
					role: "tool",
					content: `${failure.toolName} ${argsSummary}: ${failure.errorContent}`,
				}),
				Object.freeze({
					role: "mechanism",
					content: failure.mechanism,
				}),
				Object.freeze({
					role: "outcome",
					content:
						"verifiedCompletion=false reason=artifact_missing. Promotion uses held-in completion gain against this natural-failure corpus; recovery-rate is not required for tool-code-v0.",
				}),
				Object.freeze({
					role: "gap",
					content: `After the failed ${failure.toolName} call, subsequentToolCalls were empty and the verifier artifact was not produced.`,
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
