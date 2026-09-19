import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

const corpusRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../protected/tool-code-corpus-v1");

/**
 * @typedef {{
 *   toolName: "read" | "bash" | "edit" | "grep" | "write" | "find" | "ls";
 *   arguments: Record<string, unknown>;
 *   errorContent: string;
 *   mechanism: string;
 * }} NaturalFailure
 */

/**
 * @typedef {{
 *   id: string;
 *   set: "held_in" | "held_out";
 *   input: string;
 *   files: Record<string, string>;
 *   executable?: string[];
 *   verifierPath: string;
 *   expectedContent: string;
 *   naturalFailure: NaturalFailure;
 * }} TaskSpec
 */

const FLOOD_LINES = 2400;
const GREP_DECOY_COUNT = 140; // above coding-agent grep default match limit (100)
// Fat early lines force read's 50KB byte limit before the line window (Terminal-Bench truncation pattern).
const FAT_PREFIX_LINES = 40;
const FAT_LINE_PAD = "PAD".repeat(450); // ~1.3KB/line → ~50KB within first ~40 lines

function buildNoiseLines(count, prefix) {
	const lines = [];
	for (let index = 1; index <= count; index += 1) {
		lines.push(`${prefix} noise=${String(index).padStart(4, "0")} filler=${"x".repeat(24)}`);
	}
	return lines;
}

/**
 * Hostile log:
 * - Fat prefix triggers byte-limit read truncation
 * - >=100 same-key decoys saturate default grep tool
 * - Several late RELEASE_ID/BUILD_ID values; only RELEASE_AUTH / BUILD_AUTH marks the real one
 *   (bash `rg` can list all hits — ambiguity is required, not just match-limit)
 */
function buildHostileLog(needleLine, needleKey, needleValue) {
	const lines = [];
	const total = Math.max(needleLine + 200, 2600);
	const lateDecoys = [needleLine - 80, needleLine - 40, needleLine + 40, needleLine + 80].filter(
		(line) => line > GREP_DECOY_COUNT && line !== needleLine && line <= total,
	);
	for (let index = 1; index <= total; index += 1) {
		if (index === needleLine) {
			const authKey = needleKey === "RELEASE_ID" ? "RELEASE_AUTH" : "BUILD_AUTH";
			lines.push(`${authKey}=1`);
			lines.push(`${needleKey}=${needleValue}`);
			continue;
		}
		if (lateDecoys.includes(index)) {
			lines.push(`${needleKey}=${50000 + index}`);
			continue;
		}
		if (index <= FAT_PREFIX_LINES) {
			lines.push(`${needleKey}=${8000 + index} ${FAT_LINE_PAD}`);
			continue;
		}
		if (index <= GREP_DECOY_COUNT) {
			lines.push(`${needleKey}=${8000 + index}`);
			continue;
		}
		if (index % 9 === 0) {
			lines.push(`# ignore ${needleKey}=${9000 + (index % 97)}`);
		} else if (index % 8 === 0) {
			lines.push(`${needleKey}_CANDIDATE=${7000 + (index % 89)}`);
		} else {
			lines.push(`ops event=${String(index)} detail=noise`);
		}
	}
	return `${lines.join("\n")}\n`;
}

/**
 * Large pointer index: many active_config= decoys early and late.
 * Only the real path's JSON has "role":"canonical" — listing late pointers is not enough.
 */
function buildPointerIndex(realLine, realPath, decoyPaths) {
	const lines = [];
	const total = Math.max(realLine + 150, 2500);
	let decoyIndex = 0;
	const lateDecoys = [realLine - 60, realLine - 20, realLine + 20, realLine + 60].filter(
		(line) => line > GREP_DECOY_COUNT && line !== realLine && line <= total,
	);
	for (let index = 1; index <= total; index += 1) {
		if (index === realLine) {
			lines.push(`active_config=${realPath}`);
			continue;
		}
		if (lateDecoys.includes(index)) {
			const decoy = decoyPaths[decoyIndex % decoyPaths.length];
			decoyIndex += 1;
			lines.push(`active_config=${decoy}`);
			continue;
		}
		if (index <= FAT_PREFIX_LINES) {
			const decoy = decoyPaths[decoyIndex % decoyPaths.length];
			decoyIndex += 1;
			lines.push(`active_config=${decoy} ${FAT_LINE_PAD}`);
			continue;
		}
		if (index <= GREP_DECOY_COUNT) {
			const decoy = decoyPaths[decoyIndex % decoyPaths.length];
			decoyIndex += 1;
			lines.push(`active_config=${decoy}`);
			continue;
		}
		lines.push(`note=ops-index-row-${String(index)}`);
	}
	return `${lines.join("\n")}\n`;
}

/**
 * Bash flood (Recovery-Bench / Terminal-Bench style buried diagnostic):
 * - Many same-shaped ERROR_CODE=dyn-<hex> decoys
 * - Multiple AUTH_MARK lines (plausible wrong recoveries); only READY→AUTH_MARK is authoritative
 * - Auth token assembled at runtime so the final code is not a single greppable literal in the script
 */
function bashFloodScript(authCode) {
	const mid = Math.floor(FLOOD_LINES / 2);
	const prefix = authCode.slice(0, authCode.indexOf("-") + 1);
	const hex = authCode.slice(authCode.indexOf("-") + 1);
	const half = Math.ceil(hex.length / 2);
	const hexA = hex.slice(0, half);
	const hexB = hex.slice(half);
	const decoyMarks = [400, 800, 1600, 2000, 2100].filter((line) => line !== mid && line < FLOOD_LINES);
	return [
		"#!/bin/sh",
		`PREFIX=$(printf '%s' '${prefix}')`,
		`PART_A=$(printf '%s' '${hexA}')`,
		`PART_B=$(printf '%s' '${hexB}')`,
		"i=1",
		`while [ "$i" -le ${String(FLOOD_LINES)} ]; do`,
		`  if [ "$i" -eq ${String(mid)} ]; then`,
		"    echo READY",
		"    echo AUTH_MARK",
		'    echo "ERROR_CODE=${PREFIX}${PART_A}${PART_B}"',
		`  elif [ "$i" -eq ${String(decoyMarks[0])} ] || [ "$i" -eq ${String(decoyMarks[1])} ] || [ "$i" -eq ${String(decoyMarks[2])} ] || [ "$i" -eq ${String(decoyMarks[3])} ] || [ "$i" -eq ${String(decoyMarks[4])} ]; then`,
		"    echo AUTH_MARK",
		'    echo "ERROR_CODE=${PREFIX}$(printf %08x "$i")"',
		"  else",
		'    echo "ERROR_CODE=${PREFIX}$(printf %08x "$i")"',
		"  fi",
		'  echo "probe_noise line=$i pad=xxxxxxxxxxxxxxxxxxxx"',
		'  i=$((i + 1))',
		"done",
		"exit 1",
		"",
	].join("\n");
}

function bashFloodErrorContent(exitCode, codePrefix) {
	// Truncated tail looks fully populated with plausible same-shape codes (no AUTH_MARK).
	const tail = [
		...buildNoiseLines(3, "probe_noise"),
		`ERROR_CODE=${codePrefix}0000095d`,
		`ERROR_CODE=${codePrefix}0000095e`,
		`ERROR_CODE=${codePrefix}0000095f`,
		`ERROR_CODE=${codePrefix}00000960`,
	].join("\n");
	return `${tail}\n\n[Showing lines ${FLOOD_LINES - 1999}-${FLOOD_LINES} of ${FLOOD_LINES}. Full output: /tmp/pi-bash-XXXXXX.log]\n\nCommand exited with code ${String(exitCode)}`;
}

function buildAmbiguousFlagsSource(variants) {
	const blocks = [];
	for (const variant of variants.decoys) {
		blocks.push(
			[
				`// ${variant.comment}`,
				`export const ${variant.name} = {`,
				`\tMODE: "${variant.mode}",`,
				`\tregion: "${variant.region}",`,
				`\ttier: "standard",`,
				`};`,
				"",
			].join("\n"),
		);
	}
	blocks.push(
		[
			`/** live production flags — edit only this MODE */`,
			`export const ${variants.target.name} = {`,
			`\tMODE: "${variants.target.from}",`,
			`\tregion: "${variants.target.region}",`,
			`\ttier: "standard",`,
			`};`,
			"",
		].join("\n"),
	);
	for (const variant of variants.trailing) {
		blocks.push(
			[
				`export const ${variant.name} = {`,
				`\tMODE: "${variant.mode}",`,
				`\tregion: "${variant.region}",`,
				`\ttier: "standard",`,
				`};`,
				"",
			].join("\n"),
		);
	}
	return blocks.join("\n");
}

function expectedFlagsSource(variants) {
	return buildAmbiguousFlagsSource({
		...variants,
		target: { ...variants.target, from: variants.target.to },
	});
}

function heldInConfigTree(realPath) {
	const decoys = [
		"config/runtime.json",
		"config/app.example.json",
		"settings/app.json",
		"settings/runtime.backup.json",
		"ops/profiles/staging.json",
		"ops/profiles/dev.json",
		"ops/profiles/canary.json",
		"vendor/legacy/config/app.json",
		"apps/web/config/settings.json",
		"apps/api/config/settings.json",
		"ops/runtime/regions/us-west/settings.json",
		"ops/runtime/regions/eu-west/settings.json",
	];
	const files = {
		"README.md":
			"Runtime configuration path is recorded in ops/INDEX.log as active_config=... (legacy docs still mention config/app.json).\n",
		"docs/onboarding.md": "Prefer config/runtime.json for local bring-up.\n",
		"ops/INDEX.log": buildPointerIndex(2300, realPath, decoys),
	};
	for (const decoy of decoys) {
		files[decoy] = `{"mode":"decoy","path":"${decoy}"}\n`;
	}
	for (let index = 1; index <= 40; index += 1) {
		const shard = `ops/runtime/regions/us-west/shard-${String(index).padStart(2, "0")}.json`;
		files[shard] = `{"mode":"shard-${String(index)}"}\n`;
		decoys.push(shard);
	}
	files[realPath] = '{"mode":"held-in-01","role":"canonical"}\n';
	// Rebuild index with full decoy list including shards.
	files["ops/INDEX.log"] = buildPointerIndex(2300, realPath, decoys);
	return files;
}

function heldOutConfigTree(realPath) {
	const decoys = [
		"service/runtime.json",
		"service/config.example.json",
		"service/settings.json",
		"infra/service/config.json",
		"deploy/charts/api/values.json",
		"deploy/charts/worker/values.json",
		"service/runtime/east/settings.json",
		"service/runtime/central/settings.json",
	];
	const files = {
		"docs/setup.md": "Service configuration is service/config.json.\n",
		"README.md": "Authoritative pointer lives in service/INDEX.log (active_config=...).\n",
		"service/INDEX.log": buildPointerIndex(2250, realPath, decoys),
	};
	for (const decoy of decoys) {
		files[decoy] = `{"region":"decoy","path":"${decoy}"}\n`;
	}
	for (let index = 1; index <= 40; index += 1) {
		const shard = `service/runtime/cache/node-${String(index).padStart(2, "0")}.json`;
		files[shard] = `{"region":"cache-${String(index)}"}\n`;
		decoys.push(shard);
	}
	files[realPath] = '{"region":"held-out-01","role":"canonical"}\n';
	files["service/INDEX.log"] = buildPointerIndex(2250, realPath, decoys);
	return files;
}

const heldInFlags = {
	decoys: [
		{ name: "test", mode: "draft", region: "test", comment: "unit-test defaults" },
		{ name: "fixtureProduction", mode: "draft", region: "live", comment: "fixture mirror of production" },
		{ name: "staging", mode: "draft", region: "staging", comment: "staging preview" },
		{ name: "qaProductionShadow", mode: "draft", region: "live", comment: "qa shadow of production" },
		{ name: "docsExample", mode: "draft", region: "docs", comment: "docs snippet" },
		{ name: "legacyProduction", mode: "draft", region: "live", comment: "legacy production alias" },
		{ name: "productionMirror", mode: "draft", region: "live", comment: "read-only production mirror" },
		{ name: "productionFixture", mode: "draft", region: "live", comment: "production fixture block" },
	],
	target: { name: "production", from: "draft", to: "ready", region: "live" },
	trailing: [
		{ name: "canary", mode: "draft", region: "canary" },
		{ name: "sandbox", mode: "draft", region: "sandbox" },
		{ name: "loadtest", mode: "draft", region: "load" },
		{ name: "integration", mode: "draft", region: "ci" },
		{ name: "productionCanary", mode: "draft", region: "live" },
		{ name: "prod", mode: "draft", region: "live" },
	],
};

const heldOutFlags = {
	decoys: [
		{ name: "sandbox", mode: "beta", region: "sandbox", comment: "sandbox defaults" },
		{ name: "liveFixture", mode: "beta", region: "prod", comment: "fixture mirror of live" },
		{ name: "preview", mode: "beta", region: "preview", comment: "preview channel" },
		{ name: "docsLive", mode: "beta", region: "prod", comment: "docs live example" },
		{ name: "shadowLive", mode: "beta", region: "prod", comment: "shadow live" },
		{ name: "legacyLive", mode: "beta", region: "prod", comment: "legacy live alias" },
		{ name: "liveMirror", mode: "beta", region: "prod", comment: "read-only live mirror" },
		{ name: "liveFixtureBlock", mode: "beta", region: "prod", comment: "live fixture block" },
	],
	target: { name: "live", from: "beta", to: "ga", region: "prod" },
	trailing: [
		{ name: "canary", mode: "beta", region: "canary" },
		{ name: "perf", mode: "beta", region: "perf" },
		{ name: "integration", mode: "beta", region: "ci" },
		{ name: "contract", mode: "beta", region: "contract" },
		{ name: "liveCanary", mode: "beta", region: "prod" },
		{ name: "prod", mode: "beta", region: "prod" },
	],
};

const heldInRealConfig = "ops/runtime/regions/us-east/settings.json";
const heldOutRealConfig = "service/runtime/west/settings.json";
const heldInAuthCode = "dyn-7f3a91c2";
const heldOutAuthCode = "hc-19b4e2d0";
const heldInReleaseId = "48291";
const heldOutBuildId = "91734";

/** @type {TaskSpec[]} */
const tasks = [
	{
		id: "tool-code-held-in-01",
		set: "held_in",
		input:
			'Find the active runtime configuration path recorded in ops/INDEX.log (active_config=<repository-relative-path>). Among active_config candidates, choose the path whose JSON file contains "role":"canonical". Write exactly one line to answer.txt: "Configuration file: <path>". Ignore stale docs that mention config/app.json.',
		files: heldInConfigTree(heldInRealConfig),
		verifierPath: "answer.txt",
		expectedContent: `Configuration file: ${heldInRealConfig}\n`,
		naturalFailure: {
			toolName: "read",
			arguments: { path: "config/app.json" },
			errorContent: "ENOENT: no such file or directory, access 'config/app.json'",
			mechanism:
				"stale docs trigger opaque ENOENT; the true pointer sits past read/byte truncation in a large index while earlier active_config decoys saturate default grep (Terminal-Bench-style plausible wrong recoveries)",
		},
	},
	{
		id: "tool-code-held-in-02",
		set: "held_in",
		input:
			"Run ./scripts/probe.sh. On failure it emits many ERROR_CODE=... lines and multiple AUTH_MARK markers. The authoritative code is the ERROR_CODE that immediately follows the AUTH_MARK which itself immediately follows a READY line. Write exactly that ERROR_CODE value (the part after ERROR_CODE=) followed by a newline to answer.txt.",
		files: {
			"README.md": "Probe helper. Prefer ./scripts/probe.sh; ignore ./scripts/probe-legacy.sh.\n",
			"scripts/probe-legacy.sh":
				"#!/bin/sh\necho 'ERROR_CODE=legacy-do-not-use' >&2\nexit 1\n",
			"scripts/probe.sh": bashFloodScript(heldInAuthCode),
		},
		executable: ["scripts/probe.sh", "scripts/probe-legacy.sh"],
		verifierPath: "answer.txt",
		expectedContent: `${heldInAuthCode}\n`,
		naturalFailure: {
			toolName: "bash",
			arguments: { command: "./scripts/probe.sh" },
			errorContent: bashFloodErrorContent(1, "dyn-"),
			mechanism:
				"bash non-zero exits bury AUTH_MARK+ERROR_CODE mid-stream under same-shaped dyn-* decoys at head/tail (Recovery-Bench buried-diagnostic pattern); truncated failure output shows only decoys unless full-output recovery stays actionable",
		},
	},
	{
		id: "tool-code-held-in-03",
		set: "held_in",
		input:
			"logs/app.log contains multiple RELEASE_ID=<digits> lines past the default read truncation window. The authoritative one is immediately preceded by RELEASE_AUTH=1. Write exactly that authoritative full RELEASE_ID=... line followed by a newline to answer.txt.",
		files: {
			"logs/app.log": buildHostileLog(2400, "RELEASE_ID", heldInReleaseId),
			"README.md": "Application logs are under logs/. Early release markers are decoys.\n",
			"logs/README.md": "The authoritative RELEASE_ID appears once after the default read window.\n",
		},
		verifierPath: "answer.txt",
		expectedContent: `RELEASE_ID=${heldInReleaseId}\n`,
		naturalFailure: {
			toolName: "read",
			arguments: { path: "logs/app.log" },
			errorContent:
				"[truncated: showing first ~2000 lines / 50KB; use offset/limit or open the saved full output]",
			mechanism:
				"large-file read hits byte then line truncation while the first grep window is saturated with RELEASE_ID decoys (Terminal-Bench truncation + noisy recovery)",
		},
	},
	{
		id: "tool-code-held-in-04",
		set: "held_in",
		input:
			'In src/flags.ts, change only `export const production` MODE from "draft" to "ready". Leave every other MODE assignment unchanged, including productionMirror / productionFixture / prod aliases.',
		files: {
			"src/flags.ts": buildAmbiguousFlagsSource(heldInFlags),
			"README.md": "Edit export const production only.\n",
		},
		verifierPath: "src/flags.ts",
		expectedContent: expectedFlagsSource(heldInFlags),
		naturalFailure: {
			toolName: "edit",
			arguments: {
				path: "src/flags.ts",
				edits: [{ oldText: 'MODE: "draft"', newText: 'MODE: "ready"' }],
			},
			errorContent:
				'Found 15 occurrences of the text in src/flags.ts. The text must be unique. Please provide more context to make it unique.',
			mechanism:
				"edit uniqueness failures across many near-duplicate MODE blocks (including production* aliases) need precise match-location feedback so agents can narrow oldText to export const production only",
		},
	},
	{
		id: "tool-code-held-out-01",
		set: "held_out",
		input:
			'Find the active service configuration path recorded in service/INDEX.log (active_config=<repository-relative-path>). Among active_config candidates, choose the path whose JSON file contains "role":"canonical". Write exactly one line to answer.txt: "Configuration file: <path>". Ignore stale docs that mention service/config.json.',
		files: heldOutConfigTree(heldOutRealConfig),
		verifierPath: "answer.txt",
		expectedContent: `Configuration file: ${heldOutRealConfig}\n`,
		naturalFailure: {
			toolName: "read",
			arguments: { path: "service/config.json" },
			errorContent: "ENOENT: no such file or directory, access 'service/config.json'",
			mechanism:
				"stale docs trigger opaque ENOENT; the true pointer sits past read/byte truncation in a large index while earlier active_config decoys saturate default grep (Terminal-Bench-style plausible wrong recoveries)",
		},
	},
	{
		id: "tool-code-held-out-02",
		set: "held_out",
		input:
			"Run ./bin/healthcheck.sh. On failure it emits many ERROR_CODE=... lines and multiple AUTH_MARK markers. The authoritative code is the ERROR_CODE that immediately follows the AUTH_MARK which itself immediately follows a READY line. Write exactly that ERROR_CODE value (the part after ERROR_CODE=) followed by a newline to answer.txt.",
		files: {
			"README.md": "Healthcheck entrypoint is ./bin/healthcheck.sh; ignore ./bin/healthcheck.old.sh.\n",
			"bin/healthcheck.old.sh":
				"#!/bin/sh\necho 'ERROR_CODE=old-hc' >&2\nexit 2\n",
			"bin/healthcheck.sh": bashFloodScript(heldOutAuthCode),
		},
		executable: ["bin/healthcheck.sh", "bin/healthcheck.old.sh"],
		verifierPath: "answer.txt",
		expectedContent: `${heldOutAuthCode}\n`,
		naturalFailure: {
			toolName: "bash",
			arguments: { command: "./bin/healthcheck.sh" },
			errorContent: bashFloodErrorContent(1, "hc-"),
			mechanism:
				"bash non-zero exits bury AUTH_MARK+ERROR_CODE mid-stream under same-shaped hc-* decoys at head/tail (Recovery-Bench buried-diagnostic pattern); truncated failure output shows only decoys unless full-output recovery stays actionable",
		},
	},
	{
		id: "tool-code-held-out-03",
		set: "held_out",
		input:
			"data/events.log contains multiple BUILD_ID=<digits> lines past the default read truncation window. The authoritative one is immediately preceded by BUILD_AUTH=1. Write exactly that authoritative full BUILD_ID=... line followed by a newline to answer.txt.",
		files: {
			"data/events.log": buildHostileLog(2350, "BUILD_ID", heldOutBuildId),
			"NOTES.md": "Event logs are under data/. Early build markers are decoys.\n",
		},
		verifierPath: "answer.txt",
		expectedContent: `BUILD_ID=${heldOutBuildId}\n`,
		naturalFailure: {
			toolName: "read",
			arguments: { path: "data/events.log" },
			errorContent:
				"[truncated: showing first ~2000 lines / 50KB; use offset/limit or open the saved full output]",
			mechanism:
				"large-file read hits byte then line truncation while the first grep window is saturated with BUILD_ID decoys (Terminal-Bench truncation + noisy recovery)",
		},
	},
	{
		id: "tool-code-held-out-04",
		set: "held_out",
		input:
			'In config/modes.ts, change only `export const live` MODE from "beta" to "ga". Leave every other MODE assignment unchanged, including liveMirror / liveFixture / prod aliases.',
		files: {
			"config/modes.ts": buildAmbiguousFlagsSource(heldOutFlags),
			"README.md": "Edit export const live only.\n",
		},
		verifierPath: "config/modes.ts",
		expectedContent: expectedFlagsSource(heldOutFlags),
		naturalFailure: {
			toolName: "edit",
			arguments: {
				path: "config/modes.ts",
				edits: [{ oldText: 'MODE: "beta"', newText: 'MODE: "ga"' }],
			},
			errorContent:
				'Found 15 occurrences of the text in config/modes.ts. The text must be unique. Please provide more context to make it unique.',
			mechanism:
				"edit uniqueness failures across many near-duplicate MODE blocks (including live* aliases) need precise match-location feedback so agents can narrow oldText to export const live only",
		},
	},
];

async function writeTree(root, files, executable = []) {
	for (const [relativePath, content] of Object.entries(files)) {
		const absolutePath = path.join(root, relativePath);
		await mkdir(path.dirname(absolutePath), { recursive: true });
		await writeFile(absolutePath, content, "utf8");
	}
	for (const relativePath of executable) {
		await chmod(path.join(root, relativePath), 0o755);
	}
}

async function createBundle(spec) {
	const work = await mkdtemp(path.join(tmpdir(), `${spec.id}-`));
	try {
		await writeTree(work, spec.files, spec.executable ?? []);
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
	await rm(corpusRoot, { recursive: true, force: true });
	await mkdir(path.join(corpusRoot, "protected-verifiers"), { recursive: true });
	await mkdir(path.join(corpusRoot, "repositories"), { recursive: true });

	const registryTasks = [];
	/** @type {Record<string, NaturalFailure>} */
	const failureCatalog = {};

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
				url: `selfpi-corpus:tool-code-corpus-v1/repositories/${spec.id}.bundle`,
				commit,
			},
			input: spec.input,
			verifier: { id: spec.id, digest },
		});
		failureCatalog[spec.id] = {
			version: 1,
			toolName: spec.naturalFailure.toolName,
			arguments: spec.naturalFailure.arguments,
			errorContent: spec.naturalFailure.errorContent,
			mechanism: spec.naturalFailure.mechanism,
		};
	}

	const registrySource = `${JSON.stringify(
		{ version: 1, id: "tool-code-registry-v1", tasks: registryTasks },
		null,
		2,
	)}\n`;
	const registryDigest = `sha256:${createHash("sha256").update(registrySource).digest("hex")}`;
	await writeFile(path.join(corpusRoot, "task-registry.json"), registrySource, "utf8");
	await writeFile(
		path.join(corpusRoot, "failure-catalog.json"),
		`${JSON.stringify({ version: 1, id: "tool-code-failure-catalog-v1", failures: failureCatalog }, null, 2)}\n`,
		"utf8",
	);
	await writeFile(
		path.join(corpusRoot, "task-registry.metadata.json"),
		`${JSON.stringify(
			{
				version: 1,
				id: "tool-code-registry-v1",
				digest: registryDigest,
				heldInTaskCount: tasks.filter((task) => task.set === "held_in").length,
				heldOutTaskCount: tasks.filter((task) => task.set === "held_out").length,
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
