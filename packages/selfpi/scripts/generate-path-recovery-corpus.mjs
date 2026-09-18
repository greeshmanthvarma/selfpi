import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

const corpusRoot = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"../protected/path-recovery-corpus-v1",
);

/**
 * @typedef {{
 *   id: string;
 *   set: "held_in" | "held_out";
 *   input: string;
 *   files: Record<string, string>;
 *   perturbation?: { path: string; error: string };
 *   verifierPath: string;
 *   expectedContent: string;
 * }} TaskSpec
 */

const answerTxtFormat =
	'Write exactly one line to answer.txt in this form: "Configuration file: <repository-relative-path>" (including the trailing newline implied by that single line).';

/** @type {TaskSpec[]} */
const tasks = [
	{
		id: "path-recovery-held-in-01",
		set: "held_in",
		input: `Find the project configuration module. ${answerTxtFormat}`,
		files: {
			// Hint names the bait path so evaluation must hit the scheduled read.
			"README.md": "Configuration lives in src/config.ts.\n",
			"src/settings.ts": "export const mode = 'held-in-01';\n",
		},
		perturbation: { path: "src/config.ts", error: "ENOENT: no such file or directory, open 'src/config.ts'" },
		verifierPath: "answer.txt",
		expectedContent: "Configuration file: src/settings.ts\n",
	},
	{
		id: "path-recovery-held-in-02",
		set: "held_in",
		input: `Locate the nested API app settings file. ${answerTxtFormat}`,
		files: {
			"apps/api/README.md": "Runtime settings are under src/config/app.ts.\n",
			"apps/api/settings/app.ts": "export const port = 8080;\n",
		},
		perturbation: {
			path: "apps/api/src/config/app.ts",
			error: "ENOENT: no such file or directory, open 'apps/api/src/config/app.ts'",
		},
		verifierPath: "answer.txt",
		expectedContent: "Configuration file: apps/api/settings/app.ts\n",
	},
	{
		id: "path-recovery-held-in-03",
		set: "held_in",
		input: `Identify the TypeScript configuration module among similarly named files. ${answerTxtFormat}`,
		files: {
			"README.md": "Prefer src/configuration.ts as the configuration module.\n",
			"config.json": '{"kind":"json-config"}\n',
			"configuration.ts": "export const kind = 'verbose-name';\n",
			"src/config.ts": "export const kind = 'canonical';\n",
		},
		perturbation: {
			path: "src/configuration.ts",
			error: "ENOENT: no such file or directory, open 'src/configuration.ts'",
		},
		verifierPath: "answer.txt",
		expectedContent: "Configuration file: src/config.ts\n",
	},
	{
		id: "path-recovery-held-in-04",
		set: "held_in",
		input: `Find the Python settings module. ${answerTxtFormat}`,
		files: {
			"README.md": "Application settings are defined in src/config.py.\n",
			"src/settings.py": "MODE = 'held-in-04'\n",
			"src/__init__.py": "",
		},
		perturbation: { path: "src/config.py", error: "ENOENT: no such file or directory, open 'src/config.py'" },
		verifierPath: "answer.txt",
		expectedContent: "Configuration file: src/settings.py\n",
	},
	{
		id: "path-recovery-held-in-05",
		set: "held_in",
		input: `Repair the stale import by identifying the real helpers module path. ${answerTxtFormat}`,
		files: {
			"src/index.ts": "import { help } from './helpers.ts';\nexport const ready = true;\n",
			"src/lib/helpers.ts": "export const help = () => 'ok';\n",
		},
		perturbation: {
			path: "src/helpers.ts",
			error: "ENOENT: no such file or directory, open 'src/helpers.ts'",
		},
		verifierPath: "answer.txt",
		expectedContent: "Configuration file: src/lib/helpers.ts\n",
	},
	{
		id: "path-recovery-held-in-06",
		set: "held_in",
		input: `The README names a configuration file. Find the real feature flag module. ${answerTxtFormat}`,
		files: {
			"README.md": "Feature flags live in docs/flags.ts.\n",
			"services/flags/feature-flags.ts": "export const flags = { beta: false };\n",
		},
		perturbation: {
			path: "docs/flags.ts",
			error: "ENOENT: no such file or directory, open 'docs/flags.ts'",
		},
		verifierPath: "answer.txt",
		expectedContent: "Configuration file: services/flags/feature-flags.ts\n",
	},
	{
		id: "path-recovery-held-in-07",
		set: "held_in",
		input:
			'In this monorepo, find package B\'s runtime config. Write exactly one line to RESULT.md in this form: "Configuration file: <repository-relative-path>".',
		files: {
			"packages/a/package.json": '{"name":"a"}\n',
			"packages/b/package.json": '{"name":"b"}\n',
			"packages/b/README.md": "Runtime config is packages/b/src/config.ts.\n",
			"packages/b/runtime/config.ts": "export const service = 'b';\n",
			"packages/a/src/index.ts": "export {};\n",
		},
		perturbation: {
			path: "packages/b/src/config.ts",
			error: "ENOENT: no such file or directory, open 'packages/b/src/config.ts'",
		},
		verifierPath: "RESULT.md",
		expectedContent: "Configuration file: packages/b/runtime/config.ts\n",
	},
	{
		id: "path-recovery-held-in-08",
		set: "held_in",
		input:
			'Find the worker queue settings file and write exactly {"path":"<repository-relative-path>"} followed by a newline to found.json.',
		files: {
			"workers/queue/settings.toml": "concurrency = 4\n",
			"workers/README.md": "Queue settings are in config.toml beside this note.\n",
		},
		perturbation: {
			path: "workers/queue/config.toml",
			error: "ENOENT: no such file or directory, open 'workers/queue/config.toml'",
		},
		verifierPath: "found.json",
		expectedContent: '{"path":"workers/queue/settings.toml"}\n',
	},
	{
		id: "path-recovery-held-out-01",
		set: "held_out",
		input: `Find the sealed service configuration. ${answerTxtFormat}`,
		files: {
			"service/config/main.ts": "export const region = 'us-east';\n",
			"README.md": "Service configuration is service/config.ts.\n",
		},
		perturbation: {
			path: "service/config.ts",
			error: "ENOENT: no such file or directory, open 'service/config.ts'",
		},
		verifierPath: "answer.txt",
		expectedContent: "Configuration file: service/config/main.ts\n",
	},
	{
		id: "path-recovery-held-out-02",
		set: "held_out",
		input: `Locate the deeply nested theme tokens file. ${answerTxtFormat}`,
		files: {
			"ui/web/README.md": "Theme tokens live at ui/web/src/styles/tokens.ts.\n",
			"ui/web/src/theme/tokens.ts": "export const color = 'blue';\n",
		},
		perturbation: {
			path: "ui/web/src/styles/tokens.ts",
			error: "ENOENT: no such file or directory, open 'ui/web/src/styles/tokens.ts'",
		},
		verifierPath: "answer.txt",
		expectedContent: "Configuration file: ui/web/src/theme/tokens.ts\n",
	},
	{
		id: "path-recovery-held-out-03",
		set: "held_out",
		input: `Choose the Go settings file among similar names. ${answerTxtFormat}`,
		files: {
			"README.md": "Canonical settings are internal/config/settings.go.\n",
			"config.go": "package main\nvar Legacy = true\n",
			"internal/settings/settings.go": "package settings\nvar Mode = \"canonical\"\n",
			"configuration.go": "package main\nvar Verbose = true\n",
		},
		perturbation: {
			path: "internal/config/settings.go",
			error: "ENOENT: no such file or directory, open 'internal/config/settings.go'",
		},
		verifierPath: "answer.txt",
		expectedContent: "Configuration file: internal/settings/settings.go\n",
	},
	{
		id: "path-recovery-held-out-04",
		set: "held_out",
		input: `Find the Ruby application settings. ${answerTxtFormat}`,
		files: {
			"README.md": "Application settings are config/settings.rb.\n",
			"config/application.rb": "module App; end\n",
			"app/models/.keep": "",
		},
		perturbation: {
			path: "config/settings.rb",
			error: "ENOENT: no such file or directory, open 'config/settings.rb'",
		},
		verifierPath: "answer.txt",
		expectedContent: "Configuration file: config/application.rb\n",
	},
	{
		id: "path-recovery-held-out-05",
		set: "held_out",
		input: `Recover the moved database config path. ${answerTxtFormat}`,
		files: {
			"README.md": "Database config is config/database.yaml.\n",
			"infra/db/settings.yaml": "pool: 10\n",
			"src/app.ts": "export {};\n",
		},
		perturbation: {
			path: "config/database.yaml",
			error: "ENOENT: no such file or directory, open 'config/database.yaml'",
		},
		verifierPath: "answer.txt",
		expectedContent: "Configuration file: infra/db/settings.yaml\n",
	},
	{
		id: "path-recovery-held-out-06",
		set: "held_out",
		input:
			'Find package client auth settings. Write exactly one line to OUT.txt in this form: "Configuration file: <repository-relative-path>".',
		files: {
			"packages/client/README.md": "Auth settings are packages/client/auth/config.ts.\n",
			"packages/client/auth/settings.ts": "export const auth = true;\n",
			"packages/server/auth/config.ts": "export const auth = false;\n",
		},
		perturbation: {
			path: "packages/client/auth/config.ts",
			error: "ENOENT: no such file or directory, open 'packages/client/auth/config.ts'",
		},
		verifierPath: "OUT.txt",
		expectedContent: "Configuration file: packages/client/auth/settings.ts\n",
	},
	{
		id: "path-recovery-held-out-07",
		set: "held_out",
		input: `A comment points at a missing path. Find the real logger module. ${answerTxtFormat}`,
		files: {
			"src/main.ts": "// logger: ./logging/logger.ts\nexport const boot = true;\n",
			"src/util/logger.ts": "export const log = console.log;\n",
		},
		verifierPath: "answer.txt",
		expectedContent: "Configuration file: src/util/logger.ts\n",
	},
	{
		id: "path-recovery-held-out-08",
		set: "held_out",
		input: `Multiple similarly named files exist. Find the active profile config. ${answerTxtFormat}`,
		files: {
			"profiles/default.json": '{"active":true}\n',
			"profiles/default.example.json": '{"active":false}\n',
			"profiles/DEFAULT.json.bak": '{"active":false}\n',
			"docs/profiles.md": "Use profiles/default.json for the active profile.\n",
		},
		verifierPath: "answer.txt",
		expectedContent: "Configuration file: profiles/default.json\n",
	},
	{
		id: "path-recovery-held-out-09",
		set: "held_out",
		input: `The import path is stale. Identify the real middleware file. ${answerTxtFormat}`,
		files: {
			"server/app.js": "require('./middleware/auth');\n",
			"server/http/middleware/auth.js": "module.exports = {};\n",
		},
		verifierPath: "answer.txt",
		expectedContent: "Configuration file: server/http/middleware/auth.js\n",
	},
	{
		id: "path-recovery-held-out-10",
		set: "held_out",
		input: `Find the only Rust settings module in the crate. ${answerTxtFormat}`,
		files: {
			"src/lib.rs": "pub mod settings;\n",
			"src/settings.rs": 'pub const MODE: &str = "natural";\n',
			"src/config_legacy.rs": 'pub const MODE: &str = "legacy";\n',
		},
		verifierPath: "answer.txt",
		expectedContent: "Configuration file: src/settings.rs\n",
	},
	{
		id: "path-recovery-held-out-11",
		set: "held_out",
		input: `Docs disagree. Prefer the path named by CONTRIBUTING. ${answerTxtFormat}`,
		files: {
			"README.md": "Settings are in legacy/settings.ini.\n",
			"CONTRIBUTING.md": "Canonical settings path: config/settings.ini\n",
			"config/settings.ini": "mode=canonical\n",
			"legacy/settings.ini": "mode=legacy\n",
		},
		verifierPath: "answer.txt",
		expectedContent: "Configuration file: config/settings.ini\n",
	},
	{
		id: "path-recovery-held-out-12",
		set: "held_out",
		input:
			"Find the shell deploy defaults file and write exactly one repository-relative path line into deploy-path.txt.",
		files: {
			"ops/deploy/defaults.sh": "REGION=us-west\n",
			"ops/deploy/defaults.sh.example": "REGION=example\n",
			"ops/README.md": "Copy defaults.sh.example only when bootstrapping; runtime uses defaults.sh.\n",
		},
		verifierPath: "deploy-path.txt",
		expectedContent: "ops/deploy/defaults.sh\n",
	},
];

async function writeTree(root, files) {
	for (const [relativePath, content] of Object.entries(files)) {
		const absolutePath = path.join(root, relativePath);
		await mkdir(path.dirname(absolutePath), { recursive: true });
		await writeFile(absolutePath, content, "utf8");
	}
}

async function createBundle(spec) {
	const work = await mkdtemp(path.join(tmpdir(), `${spec.id}-`));
	try {
		await writeTree(work, spec.files);
		await executeFile("git", ["-c", "init.defaultBranch=main", "init", "--quiet"], { cwd: work });
		await executeFile("git", ["-c", "core.hooksPath=/dev/null", "add", "."], { cwd: work });
		await executeFile(
			"git",
			[
				"-c",
				"core.hooksPath=/dev/null",
				"-c",
				"user.name=SelfPi Corpus",
				"-c",
				"user.email=selfpi-corpus@example.invalid",
				"commit",
				"--quiet",
				"-m",
				spec.id,
			],
			{ cwd: work },
		);
		const commit = (await executeFile("git", ["rev-parse", "HEAD"], { cwd: work })).stdout.trim();
		const bundlePath = path.join(corpusRoot, "repositories", `${spec.id}.bundle`);
		await mkdir(path.dirname(bundlePath), { recursive: true });
		await executeFile("git", ["bundle", "create", bundlePath, "HEAD"], { cwd: work });
		return commit;
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

async function main() {
	await mkdir(path.join(corpusRoot, "protected-verifiers"), { recursive: true });
	await mkdir(path.join(corpusRoot, "repositories"), { recursive: true });
	const registryTasks = [];
	for (const spec of tasks) {
		const commit = await createBundle(spec);
		const verifierSource = `${JSON.stringify({
			version: 1,
			id: spec.id,
			verifier: { type: "exact_file", path: spec.verifierPath, expectedContent: spec.expectedContent },
		})}\n`;
		const digest = `sha256:${createHash("sha256").update(verifierSource).digest("hex")}`;
		await writeFile(path.join(corpusRoot, "protected-verifiers", `${spec.id}.json`), verifierSource, "utf8");
		registryTasks.push({
			id: spec.id,
			set: spec.set,
			repository: {
				url: `selfpi-corpus:repositories/${spec.id}.bundle`,
				commit,
			},
			input: spec.input,
			verifier: { id: spec.id, digest },
			...(spec.perturbation === undefined
				? {}
				: {
						perturbation: {
							version: 1,
							path: spec.perturbation.path,
							error: spec.perturbation.error,
						},
					}),
		});
	}
	const registrySource = `${JSON.stringify({ version: 1, id: "path-recovery-registry-v1", tasks: registryTasks }, null, 2)}\n`;
	const registryDigest = `sha256:${createHash("sha256").update(registrySource).digest("hex")}`;
	await writeFile(path.join(corpusRoot, "task-registry.json"), registrySource, "utf8");
	await writeFile(
		path.join(corpusRoot, "task-registry.metadata.json"),
		`${JSON.stringify(
			{
				version: 1,
				id: "path-recovery-registry-v1",
				digest: registryDigest,
				heldInTaskCount: 8,
				heldOutTaskCount: 12,
				content: "redacted",
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	process.stdout.write(`${registryDigest}\n`);
}

await main();
