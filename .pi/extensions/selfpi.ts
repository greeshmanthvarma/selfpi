import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createPathRecoveryExtension,
	registerSelfPiSlashCommand,
} from "../../packages/selfpi/src/index.ts";

export default function selfPiExtension(pi: ExtensionAPI): void {
	createPathRecoveryExtension()(pi);
	registerSelfPiSlashCommand(pi);
}
