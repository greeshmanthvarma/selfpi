import type { VerificationResult } from "../evaluation/verify-task.ts";
import {
	extractToolFailureSignatures,
	type SubsequentToolCall,
	type ToolFailureSignature,
} from "./extract-tool-failures.ts";

export type { SubsequentToolCall };

export type PathRecoveryFailureSignature = ToolFailureSignature & {
	readonly toolName: "read";
};

export function extractPathRecoveryFailureSignatures(
	sessionJsonl: string,
	verification: VerificationResult,
): readonly PathRecoveryFailureSignature[] {
	return extractToolFailureSignatures(sessionJsonl, verification, {
		toolNames: ["read"],
	}) as readonly PathRecoveryFailureSignature[];
}
