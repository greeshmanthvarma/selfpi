import type { Experiment } from "../experiments/load-experiment.ts";

/**
 * Widened-but-bounded pack: coding-agent tool implementation code.
 * See packages/selfpi/docs/tool-code-pack-v1.md.
 */
export const TOOL_CODE_PACK_V1_ID = "tool-code-v0";

export const TOOL_CODE_PACK_V1_EDITABLE_SURFACE = Object.freeze(["packages/coding-agent/src/core/tools/**"] as const);

export const TOOL_CODE_PACK_V1_PROTECTED_SURFACE = Object.freeze([
	"packages/selfpi/**",
	"packages/selfpi-recovery-policy/**",
	".selfpi/**",
	"packages/coding-agent/src/core/extensions/**",
	"packages/coding-agent/src/core/auth-storage.ts",
	"packages/coding-agent/src/core/model-runtime.ts",
	"packages/coding-agent/src/core/agent-session.ts",
	"packages/coding-agent/src/core/agent-session-runtime.ts",
	"packages/coding-agent/src/core/session-manager.ts",
	"packages/ai/**",
] as const);

export interface EditablePackSurfaces {
	readonly editableSurface: readonly string[];
	readonly protectedSurface: readonly string[];
}

function surfaceRoot(pattern: string): string {
	return pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern;
}

function surfacesOverlap(leftPattern: string, rightPattern: string): boolean {
	const leftRoot = surfaceRoot(leftPattern);
	const rightRoot = surfaceRoot(rightPattern);
	return leftRoot === rightRoot || leftRoot.startsWith(`${rightRoot}/`) || rightRoot.startsWith(`${leftRoot}/`);
}

/** Returns overlapping editable/protected pairs; empty means the pack surfaces are valid. */
export function findEditableProtectedOverlaps(surfaces: EditablePackSurfaces): readonly string[] {
	const overlaps: string[] = [];
	for (const editable of surfaces.editableSurface) {
		for (const protectedPath of surfaces.protectedSurface) {
			if (surfacesOverlap(editable, protectedPath)) {
				overlaps.push(`${editable} overlaps ${protectedPath}`);
			}
		}
	}
	return Object.freeze(overlaps);
}

export function toolCodePackV1Surfaces(): EditablePackSurfaces {
	return Object.freeze({
		editableSurface: TOOL_CODE_PACK_V1_EDITABLE_SURFACE,
		protectedSurface: TOOL_CODE_PACK_V1_PROTECTED_SURFACE,
	});
}

export const TOOL_CODE_PACK_V1_HELD_IN = Object.freeze([
	"tool-code-held-in-01",
	"tool-code-held-in-02",
	"tool-code-held-in-03",
	"tool-code-held-in-04",
] as const);

export const TOOL_CODE_PACK_V1_HELD_OUT = Object.freeze([
	"tool-code-held-out-01",
	"tool-code-held-out-02",
	"tool-code-held-out-03",
	"tool-code-held-out-04",
] as const);

export function createToolCodePackV1Experiment(): Experiment {
	const surfaces = toolCodePackV1Surfaces();
	const overlaps = findEditableProtectedOverlaps(surfaces);
	if (overlaps.length > 0) {
		throw new Error(`tool-code pack surfaces overlap: ${overlaps.join("; ")}`);
	}
	return Object.freeze({
		version: 1,
		id: TOOL_CODE_PACK_V1_ID,
		heldIn: TOOL_CODE_PACK_V1_HELD_IN,
		heldOut: TOOL_CODE_PACK_V1_HELD_OUT,
		budget: Object.freeze({
			wallClockMs: 1_800_000,
			toolCalls: 80,
			turns: 40,
			tokens: 500_000,
			costUsd: 25,
		}),
		editableSurface: surfaces.editableSurface,
		protectedSurface: surfaces.protectedSurface,
		promotionPolicy: Object.freeze({
			minimumHeldInCompletionGain: 1,
			maximumHeldOutCompletionLoss: 0,
			requireRecoveryRateImprovement: false,
		}),
	});
}
