import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSelfPiSlashCommand } from "../../packages/selfpi/src/extensions/selfpi-slash-command.ts";
import { createPathRecoveryExtension } from "../../packages/selfpi/src/policy/path-recovery-extension.ts";

export default function selfPiExtension(pi: ExtensionAPI): void {
	createPathRecoveryExtension()(pi);
	registerSelfPiSlashCommand(pi);
}
