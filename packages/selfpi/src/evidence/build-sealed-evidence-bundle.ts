import { createHash } from "node:crypto";
import type { VerificationResult } from "../evaluation/verify-task.ts";
import type { PathRecoveryFailureSignature } from "./extract-path-recovery-failures.ts";

export interface RedactedRepresentativeTrace {
	readonly taskId: string;
	readonly entries: readonly { readonly role: string; readonly content: string }[];
}

export interface ProposalSchemaSummary {
	readonly version: 1;
	readonly requiredFields: readonly string[];
}

export interface ProposalChangeBudget {
	readonly expectedMaximumChangedLines: number;
	readonly justificationRequiredAbove: number;
	readonly humanApprovalAbove: number;
}

export interface EvidenceBundleSource {
	readonly heldInFailures: readonly PathRecoveryFailureSignature[];
	readonly redactedRepresentativeTraces: readonly RedactedRepresentativeTrace[];
	readonly heldInVerifierOutcomes: readonly VerificationResult[];
	readonly preservedSuccesses: readonly { readonly taskId: string; readonly verifiedCompletion: true }[];
	readonly editableSource: readonly { readonly path: string; readonly content: string }[];
	readonly rejectedHypotheses: readonly { readonly hypothesis: string; readonly reason: string }[];
	readonly proposalSchema: ProposalSchemaSummary;
	readonly editableSurface: readonly string[];
	readonly changeBudget: ProposalChangeBudget;
	readonly heldOutTaskIds: readonly string[];
	readonly perturbationSchedules: readonly { readonly path: string }[];
}

export interface SealedEvidenceBundle {
	readonly version: 1;
	readonly heldInFailures: readonly PathRecoveryFailureSignature[];
	readonly redactedRepresentativeTraces: readonly RedactedRepresentativeTrace[];
	readonly heldInVerifierOutcomes: readonly VerificationResult[];
	readonly preservedSuccesses: readonly { readonly taskId: string; readonly verifiedCompletion: true }[];
	readonly editableSource: readonly { readonly path: string; readonly content: string }[];
	readonly rejectedHypotheses: readonly { readonly hypothesis: string; readonly reason: string }[];
	readonly proposalSchema: ProposalSchemaSummary;
	readonly editableSurface: readonly string[];
	readonly changeBudget: ProposalChangeBudget;
}

export interface SealedEvidenceBundleArtifact {
	readonly bundle: SealedEvidenceBundle;
	readonly digest: string;
}

function cloneFailureSignature(signature: PathRecoveryFailureSignature): PathRecoveryFailureSignature {
	return Object.freeze({
		version: 1,
		taskId: signature.taskId,
		verifiedCompletion: signature.verifiedCompletion,
		verification: Object.freeze({
			verifiedCompletion: signature.verification.verifiedCompletion,
			reason: signature.verification.reason,
		}),
		toolCallId: signature.toolCallId,
		toolName: "read",
		arguments: Object.freeze({ ...signature.arguments }),
		errorContent: signature.errorContent,
		sourceEntryIds: Object.freeze({
			toolCall: signature.sourceEntryIds.toolCall,
			toolResult: signature.sourceEntryIds.toolResult,
		}),
		subsequentToolCalls: Object.freeze(
			signature.subsequentToolCalls.map((call) =>
				Object.freeze({
					sourceEntryId: call.sourceEntryId,
					toolName: call.toolName,
					arguments: Object.freeze({ ...call.arguments }),
				}),
			),
		),
	});
}

export function buildSealedEvidenceBundle(source: EvidenceBundleSource): SealedEvidenceBundleArtifact {
	const bundle: SealedEvidenceBundle = Object.freeze({
		version: 1,
		heldInFailures: Object.freeze(source.heldInFailures.map(cloneFailureSignature)),
		redactedRepresentativeTraces: Object.freeze(
			source.redactedRepresentativeTraces.map((trace) =>
				Object.freeze({
					taskId: trace.taskId,
					entries: Object.freeze(trace.entries.map(({ role, content }) => Object.freeze({ role, content }))),
				}),
			),
		),
		heldInVerifierOutcomes: Object.freeze(
			source.heldInVerifierOutcomes.map(({ taskId, verifiedCompletion, reason }) =>
				Object.freeze({ taskId, verifiedCompletion, reason }),
			),
		),
		preservedSuccesses: Object.freeze(
			source.preservedSuccesses.map(({ taskId, verifiedCompletion }) =>
				Object.freeze({ taskId, verifiedCompletion }),
			),
		),
		editableSource: Object.freeze(source.editableSource.map(({ path, content }) => Object.freeze({ path, content }))),
		rejectedHypotheses: Object.freeze(
			source.rejectedHypotheses.map(({ hypothesis, reason }) => Object.freeze({ hypothesis, reason })),
		),
		proposalSchema: Object.freeze({
			version: 1,
			requiredFields: Object.freeze([...source.proposalSchema.requiredFields]),
		}),
		editableSurface: Object.freeze([...source.editableSurface]),
		changeBudget: Object.freeze({
			expectedMaximumChangedLines: source.changeBudget.expectedMaximumChangedLines,
			justificationRequiredAbove: source.changeBudget.justificationRequiredAbove,
			humanApprovalAbove: source.changeBudget.humanApprovalAbove,
		}),
	});
	const digest = createHash("sha256").update(JSON.stringify(bundle)).digest("hex");
	return Object.freeze({ bundle, digest: `sha256:${digest}` });
}
