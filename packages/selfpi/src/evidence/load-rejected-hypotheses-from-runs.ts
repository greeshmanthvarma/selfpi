import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface RejectedHypothesis {
	readonly hypothesis: string;
	readonly reason: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reasonFromDecision(decision: Readonly<Record<string, unknown>>): string {
	const reasons = decision.reasons;
	if (!Array.isArray(reasons)) {
		return typeof decision.decision === "string" ? `run_${decision.decision}` : "rejected";
	}
	const failed = reasons
		.filter(
			(entry): entry is Readonly<Record<string, unknown>> =>
				isRecord(entry) && entry.passed === false && typeof entry.code === "string",
		)
		.map((entry) => entry.code);
	return failed.length > 0 ? failed.join(",") : "rejected";
}

/**
 * Load rejected candidate hypotheses from prior runs of the same experiment.
 * Used so later proposers do not resample known-dead ideas.
 */
export async function loadRejectedHypothesesFromRuns(
	rootDirectory: string,
	experimentId: string,
): Promise<readonly RejectedHypothesis[]> {
	const runsDirectory = path.join(rootDirectory, "runs");
	let entries: string[] = [];
	try {
		entries = await readdir(runsDirectory);
	} catch {
		return Object.freeze([]);
	}

	const rejected: RejectedHypothesis[] = [];
	const seen = new Set<string>();
	for (const entry of entries.sort()) {
		const runDirectory = path.join(runsDirectory, entry);
		let manifestValue: unknown;
		try {
			manifestValue = JSON.parse(await readFile(path.join(runDirectory, "manifest.json"), "utf8"));
		} catch {
			continue;
		}
		if (!isRecord(manifestValue) || manifestValue.experimentId !== experimentId) {
			continue;
		}
		if (manifestValue.state !== "rejected" && manifestValue.state !== "invalid") {
			continue;
		}

		let proposalValue: unknown;
		try {
			proposalValue = JSON.parse(await readFile(path.join(runDirectory, "candidate-proposal.json"), "utf8"));
		} catch {
			continue;
		}
		if (!isRecord(proposalValue) || typeof proposalValue.hypothesis !== "string") {
			continue;
		}
		const hypothesis = proposalValue.hypothesis.trim();
		if (hypothesis.length === 0 || seen.has(hypothesis)) {
			continue;
		}

		let reason = `prior_${String(manifestValue.state)}`;
		try {
			const decisionValue: unknown = JSON.parse(await readFile(path.join(runDirectory, "decision.json"), "utf8"));
			if (isRecord(decisionValue)) {
				reason = reasonFromDecision(decisionValue);
			}
		} catch {
			// Keep the state-derived reason when decision artifacts are absent.
		}

		seen.add(hypothesis);
		rejected.push(Object.freeze({ hypothesis, reason }));
	}
	return Object.freeze(rejected);
}
