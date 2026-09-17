import type { ProposalChangeBudget } from "../evidence/build-sealed-evidence-bundle.ts";
import type { CandidateProposal } from "../proposal/validate-candidate-proposal.ts";

export interface CandidatePolicyInput {
	readonly proposal: CandidateProposal;
	readonly editableSurface: readonly string[];
	readonly protectedSurface: readonly string[];
	readonly checks: {
		readonly appliesCleanly: boolean;
		readonly formatting: boolean;
		readonly typeChecking: boolean;
		readonly targetedTests: boolean;
	};
	readonly changeBudget: ProposalChangeBudget;
}

export interface CandidatePolicyViolation {
	readonly code:
		| "outside_editable_surface"
		| "protected_surface_change"
		| "surface_overlap"
		| "protected_file_change"
		| "forbidden_capability"
		| "diff_does_not_apply"
		| "formatting_failed"
		| "type_checking_failed"
		| "targeted_tests_failed";
	readonly path?: string;
}

export interface CandidatePolicyResult {
	readonly eligible: boolean;
	readonly size: "expected" | "justification_required" | "human_approval_required";
	readonly changedLines: number;
	readonly violations: readonly CandidatePolicyViolation[];
}

function surfaceRoot(pattern: string): string {
	return pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern;
}

function matchesSurface(path: string, pattern: string): boolean {
	const root = surfaceRoot(pattern);
	return path === root || (pattern.endsWith("/**") && path.startsWith(`${root}/`));
}

function surfacesOverlap(left: string, right: string): boolean {
	const leftRoot = surfaceRoot(left);
	const rightRoot = surfaceRoot(right);
	return leftRoot === rightRoot || leftRoot.startsWith(`${rightRoot}/`) || rightRoot.startsWith(`${leftRoot}/`);
}

export function evaluateCandidatePolicy(input: CandidatePolicyInput): CandidatePolicyResult {
	const violations: CandidatePolicyViolation[] = [];
	for (const path of input.proposal.changedPaths) {
		if (!input.editableSurface.some((pattern) => matchesSurface(path, pattern))) {
			violations.push({ code: "outside_editable_surface", path });
		}
		if (input.protectedSurface.some((pattern) => matchesSurface(path, pattern))) {
			violations.push({ code: "protected_surface_change", path });
		}
		if (
			!path.endsWith(".ts") ||
			path.includes("/test/") ||
			path.endsWith("package.json") ||
			path.endsWith("package-lock.json") ||
			path.endsWith("npm-shrinkwrap.json")
		) {
			violations.push({ code: "protected_file_change", path });
		}
	}
	if (
		input.editableSurface.some((editable) =>
			input.protectedSurface.some((protectedPath) => surfacesOverlap(editable, protectedPath)),
		)
	) {
		violations.push({ code: "surface_overlap" });
	}
	const additions = input.proposal.unifiedDiff
		.split("\n")
		.filter((line) => line.startsWith("+") && !line.startsWith("+++"));
	if (
		additions.some((line) =>
			/(?:node:(?:fs|net|http|https|child_process)|process\.env|\bfetch\s*\(|\bimport\s*\()/.test(line),
		)
	) {
		violations.push({ code: "forbidden_capability" });
	}
	if (!input.checks.appliesCleanly) violations.push({ code: "diff_does_not_apply" });
	if (!input.checks.formatting) violations.push({ code: "formatting_failed" });
	if (!input.checks.typeChecking) violations.push({ code: "type_checking_failed" });
	if (!input.checks.targetedTests) violations.push({ code: "targeted_tests_failed" });

	const changedLines = input.proposal.unifiedDiff
		.split("\n")
		.filter(
			(line) =>
				(line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---")),
		).length;
	const size =
		changedLines > input.changeBudget.humanApprovalAbove
			? "human_approval_required"
			: changedLines > input.changeBudget.justificationRequiredAbove
				? "justification_required"
				: "expected";
	return Object.freeze({
		eligible: violations.length === 0,
		size,
		changedLines,
		violations: Object.freeze(violations.map((violation) => Object.freeze(violation))),
	});
}
