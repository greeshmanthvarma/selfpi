#!/usr/bin/env node

import { join } from "node:path";
import { runSelfPiCli } from "./cli/run-selfpi-cli.ts";
import { createGitPromotionReferenceAdapter } from "./promotion/promote-run.ts";

try {
	const repositoryDirectory = process.cwd();
	process.exitCode = await runSelfPiCli(process.argv.slice(2), {
		rootDirectory: join(repositoryDirectory, ".selfpi"),
		repositoryDirectory,
		write: (text) => process.stdout.write(text),
		referenceAdapter: createGitPromotionReferenceAdapter(repositoryDirectory),
	});
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
