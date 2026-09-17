import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerSelfPiSlashCommand(pi: ExtensionAPI): void {
	pi.registerCommand("selfpi", {
		description: "Start a SelfPi improvement cycle (usage: /selfpi improve <experiment>)",
		handler: async (args, ctx) => {
			const [subcommand, experiment, ...extra] = args.trim().split(/\s+/);
			if (subcommand !== "improve" || !experiment || extra.length > 0) {
				ctx.ui.notify("Usage: /selfpi improve <experiment>", "warning");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("SelfPi can only start when the agent is idle.", "warning");
				return;
			}
			pi.sendUserMessage(
				`Start one bounded SelfPi improvement cycle for experiment "${experiment}". ` +
					"Use the most recent eligible saved failure evidence. " +
					"Persist every completed transition and stop at invalid, rejected, or promotion_recommended. " +
					"Do not promote automatically.",
			);
		},
	});
}
