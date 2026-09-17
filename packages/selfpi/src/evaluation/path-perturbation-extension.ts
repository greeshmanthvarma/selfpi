import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export interface PathPerturbationSchedule {
	readonly version: 1;
	readonly path: string;
	readonly error: string;
}

export type PathPerturbationRecord =
	| {
			readonly version: 1;
			readonly fired: false;
	  }
	| {
			readonly version: 1;
			readonly fired: true;
			readonly toolCallSequence: number;
			readonly toolCallId: string;
			readonly path: string;
			readonly error: string;
	  };

export interface PathPerturbationExtension {
	readonly extension: ExtensionFactory;
	getRecord(): PathPerturbationRecord;
}

export function createPathPerturbationExtension(schedule: PathPerturbationSchedule): PathPerturbationExtension {
	let toolCallSequence = 0;
	let record: PathPerturbationRecord = Object.freeze({ version: 1, fired: false });
	const extension: ExtensionFactory = (pi) => {
		pi.on("tool_call", (event) => {
			toolCallSequence += 1;
			if (record.fired || event.toolName !== "read" || event.input.path !== schedule.path) {
				return undefined;
			}
			record = Object.freeze({
				version: 1,
				fired: true,
				toolCallSequence,
				toolCallId: event.toolCallId,
				path: schedule.path,
				error: schedule.error,
			});
			return { block: true, reason: schedule.error };
		});
	};

	return Object.freeze({
		extension,
		getRecord() {
			return record;
		},
	});
}
