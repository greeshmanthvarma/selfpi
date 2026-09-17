#!/usr/bin/env node

import { join } from "node:path";
import { runSelfPiCli } from "./cli/run-selfpi-cli.ts";

try {
	process.exitCode = await runSelfPiCli(process.argv.slice(2), {
		rootDirectory: join(process.cwd(), ".selfpi"),
		write: (text) => process.stdout.write(text),
	});
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
