import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DockerProcessAdapter } from "../gateway/create-gateway-only-network.ts";

const executeFile = promisify(execFile);

function asUtf8(value: string | Buffer): string {
	return typeof value === "string" ? value : Buffer.from(value).toString("utf8");
}

export function createExecDockerProcessAdapter(options: {
	readonly executable: string;
	readonly baseArgs?: readonly string[];
	readonly environment?: Readonly<Record<string, string>>;
}): DockerProcessAdapter {
	return {
		async run(args) {
			try {
				const result = await executeFile(options.executable, [...(options.baseArgs ?? []), ...args], {
					env: {
						PATH: process.env.PATH ?? "",
						...options.environment,
					},
					maxBuffer: 16 * 1024 * 1024,
				});
				return {
					stdout: asUtf8(result.stdout),
					stderr: asUtf8(result.stderr),
					exitCode: 0,
				};
			} catch (error) {
				if (
					typeof error === "object" &&
					error !== null &&
					"stdout" in error &&
					"stderr" in error &&
					"code" in error
				) {
					const failed = error as {
						stdout: Buffer | string;
						stderr: Buffer | string;
						code: number | string | null;
					};
					return {
						stdout: asUtf8(failed.stdout),
						stderr: asUtf8(failed.stderr),
						exitCode: typeof failed.code === "number" ? failed.code : 1,
					};
				}
				throw error;
			}
		},
	};
}
