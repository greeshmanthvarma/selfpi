import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import selfPiExtension from "../../../.pi/extensions/selfpi.ts";

describe("SelfPi slash command", () => {
	it("delegates improvement to the controller without prompting the active agent", async () => {
		let commandName = "";
		let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
		let userMessage = "";
		let notification = "";
		const extensionApi = {
			registerCommand(name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]) {
				commandName = name;
				command = options;
			},
			sendUserMessage(content: string) {
				userMessage = content;
			},
		} as unknown as ExtensionAPI;
		selfPiExtension(extensionApi);

		const context = {
			cwd: "/repository",
			isIdle: () => true,
			ui: {
				notify(message: string) {
					notification = message;
				},
			},
		} as unknown as ExtensionCommandContext;
		await command?.handler("improve path-recovery-v0", context);

		expect(commandName).toBe("selfpi");
		expect(userMessage).toBe("");
		expect(notification).toBe("SelfPi improve is unavailable until controller orchestration is implemented.");
	});
});
