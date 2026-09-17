import { createHash } from "node:crypto";

export interface EvidenceBundleSource {
	readonly heldInFailures: readonly { readonly taskId: string; readonly errorContent: string }[];
	readonly preservedSuccesses: readonly { readonly taskId: string; readonly verifiedCompletion: true }[];
	readonly editableSource: readonly { readonly path: string; readonly content: string }[];
	readonly rejectedHypotheses: readonly { readonly hypothesis: string; readonly reason: string }[];
	readonly heldOutTaskIds: readonly string[];
	readonly perturbationSchedules: readonly { readonly path: string }[];
}

export interface SealedEvidenceBundle {
	readonly version: 1;
	readonly heldInFailures: readonly { readonly taskId: string; readonly errorContent: string }[];
	readonly preservedSuccesses: readonly { readonly taskId: string; readonly verifiedCompletion: true }[];
	readonly editableSource: readonly { readonly path: string; readonly content: string }[];
	readonly rejectedHypotheses: readonly { readonly hypothesis: string; readonly reason: string }[];
}

export interface SealedEvidenceBundleArtifact {
	readonly bundle: SealedEvidenceBundle;
	readonly digest: string;
}

export function buildSealedEvidenceBundle(source: EvidenceBundleSource): SealedEvidenceBundleArtifact {
	const bundle: SealedEvidenceBundle = Object.freeze({
		version: 1,
		heldInFailures: Object.freeze(
			source.heldInFailures.map(({ taskId, errorContent }) => Object.freeze({ taskId, errorContent })),
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
	});
	const digest = createHash("sha256").update(JSON.stringify(bundle)).digest("hex");
	return Object.freeze({ bundle, digest: `sha256:${digest}` });
}
