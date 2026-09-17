import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import selfPiExtension from "../../../.pi/extensions/selfpi.ts";

describe("SelfPi slash command", () => {
	it("starts one bounded improvement cycle for the named experiment", async () => {
		let commandName = "";
		let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
		let userMessage = "";
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

		const context = { isIdle: () => true } as unknown as ExtensionCommandContext;
		await command?.handler("improve path-recovery-v0", context);

		expect(commandName).toBe("selfpi");
		expect(userMessage).toContain('Start one bounded SelfPi improvement cycle for experiment "path-recovery-v0".');
		expect(userMessage).toContain("Use the most recent eligible saved failure evidence.");
		expect(userMessage).toContain("Do not promote automatically.");
	});
});
