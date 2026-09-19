import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runSelfPiCli } from "../cli/run-selfpi-cli.ts";
import { createGitPromotionReferenceAdapter } from "../promotion/promote-run.ts";

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
			let output = "";
			const exitCode = await runSelfPiCli(["improve", experiment], {
				rootDirectory: join(ctx.cwd, ".selfpi"),
				repositoryDirectory: ctx.cwd,
				write: (text) => {
					output += text;
				},
				referenceAdapter: createGitPromotionReferenceAdapter(ctx.cwd),
			});
			ctx.ui.notify(output.trim(), exitCode === 0 ? "info" : "warning");
		},
	});
}
