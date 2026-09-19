import type { TextContent } from "@earendil-works/pi-ai";

export interface PathRecoveryInput {
	readonly toolName: string;
	readonly args: Readonly<Record<string, unknown>>;
	readonly content: readonly TextContent[];
	readonly isError: boolean;
}

export interface PathRecoveryDecision {
	readonly content: readonly TextContent[];
}

export function applyPathRecoveryPolicy(_input: PathRecoveryInput): PathRecoveryDecision | undefined {
	return undefined;
}
