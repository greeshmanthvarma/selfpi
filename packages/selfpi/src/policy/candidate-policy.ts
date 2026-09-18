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
	readonly humanApproval: boolean;
}

export interface CandidatePolicyViolation {
	readonly code:
		| "outside_editable_surface"
		| "protected_surface_change"
		| "surface_overlap"
		| "protected_file_change"
		| "forbidden_capability"
		| "unfireable_recovery_policy"
		| "destructive_recovery_content"
		| "diff_does_not_apply"
		| "formatting_failed"
		| "type_checking_failed"
		| "targeted_tests_failed"
		| "missing_size_justification"
		| "missing_human_approval";
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
			/(?:["'](?:node:)?(?:fs(?:\/promises)?|net|http2?|https|tls|dgram|dns|child_process|cluster|worker_threads|vm)["']|\brequire\s*\(\s*["'](?:node:)?(?:fs(?:\/promises)?|net|http2?|https|tls|dgram|dns|child_process|cluster|worker_threads|vm)["']\s*\)|\bprocess\.|\b(?:fetch|WebSocket|EventSource)\s*\(|\bimport\s*\(|(?:\.ssh|\.aws|\.npmrc|\.env)\b)/.test(
				line,
			),
		)
	) {
		violations.push({ code: "forbidden_capability" });
	}
	if (!input.checks.appliesCleanly) violations.push({ code: "diff_does_not_apply" });
	if (!input.checks.formatting) violations.push({ code: "formatting_failed" });
	if (!input.checks.typeChecking) violations.push({ code: "type_checking_failed" });
	if (!input.checks.targetedTests) violations.push({ code: "targeted_tests_failed" });

	const addedLines = additions.join("\n");
	const touchesRecoveryPolicy = input.proposal.changedPaths.some((path) =>
		path.includes("packages/selfpi-recovery-policy/"),
	);
	// Recovery-policy-only: PathRecoveryInput.content is always present at the hook.
	if (touchesRecoveryPolicy) {
		if (
			/\btypeof\s+(?:input\.)?content\s*===?\s*["']undefined["']/.test(addedLines) ||
			/\b(?:input\.)?content\s*(?:===|!==)\s*(?:undefined|null)\b/.test(addedLines) ||
			/\b(?:input\.)?content\s*==\s*null\b/.test(addedLines)
		) {
			violations.push({ code: "unfireable_recovery_policy" });
		}
		if (
			/content:\s*\[\s*\]/.test(addedLines) ||
			/content:\s*\[\s*\{\s*type:\s*["']text["']\s*,\s*text:\s*["']\s*["']\s*\}\s*\]/.test(addedLines)
		) {
			violations.push({ code: "destructive_recovery_content" });
		}
	}

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
	if (size !== "expected" && !input.proposal.changeJustification?.trim()) {
		violations.push({ code: "missing_size_justification" });
	}
	if (size === "human_approval_required" && !input.humanApproval) {
		violations.push({ code: "missing_human_approval" });
	}
	return Object.freeze({
		eligible: violations.length === 0,
		size,
		changedLines,
		violations: Object.freeze(violations.map((violation) => Object.freeze(violation))),
	});
}
