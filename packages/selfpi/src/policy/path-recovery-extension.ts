import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { applyPathRecoveryPolicy, type PathRecoveryDecision, type PathRecoveryInput } from "@selfpi/recovery-policy";

export type PathRecoveryPolicy = (input: PathRecoveryInput) => PathRecoveryDecision | undefined;

export function createPathRecoveryExtension(policy: PathRecoveryPolicy = applyPathRecoveryPolicy): ExtensionFactory {
	return (pi) => {
		pi.on("tool_result", (event) => {
			if (event.toolName !== "read" || !event.isError || !event.content.every((part) => part.type === "text")) {
				return undefined;
			}
			const decision = policy({
				toolName: event.toolName,
				args: event.input,
				content: event.content,
				isError: event.isError,
			});
			return decision === undefined ? undefined : { content: [...decision.content] };
		});
	};
}
