import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSelfPiSlashCommand } from "../../packages/selfpi/src/index.ts";

export default function selfPiExtension(pi: ExtensionAPI): void {
	registerSelfPiSlashCommand(pi);
}
