#!/usr/bin/env node

import { join } from "node:path";
import { runSelfPiCli } from "./cli/run-selfpi-cli.ts";
import { createFakeModelGatewayUpstream } from "./gateway/fake-model-gateway-upstream.ts";
import { createHttpModelGatewayUpstream } from "./gateway/http-model-gateway-upstream.ts";
import { createGitPromotionReferenceAdapter } from "./promotion/promote-run.ts";
import { loadSupervisedSeamsFromEnvironment } from "./supervised/open-supervised-improvement-lifecycle.ts";

try {
	const repositoryDirectory = process.cwd();
	const environment = process.env;
	const supervisedSeams =
		environment.SELFPI_PROVIDER_CREDENTIALS_JSON === undefined
			? undefined
			: loadSupervisedSeamsFromEnvironment(environment, {
					upstream:
						environment.SELFPI_FAKE_MODEL_UPSTREAM === "1"
							? createFakeModelGatewayUpstream()
							: createHttpModelGatewayUpstream(),
				});
	process.exitCode = await runSelfPiCli(process.argv.slice(2), {
		rootDirectory: join(repositoryDirectory, ".selfpi"),
		repositoryDirectory,
		write: (text) => process.stdout.write(text),
		referenceAdapter: createGitPromotionReferenceAdapter(repositoryDirectory),
		...(supervisedSeams === undefined ? {} : { supervisedSeams }),
	});
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
