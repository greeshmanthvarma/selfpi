import type { EvaluationTask } from "../verify-task.ts";

export const pathRecovery01Task: EvaluationTask = Object.freeze({
	id: "path-recovery-01",
	verifier: Object.freeze({
		type: "exact_file",
		path: "answer.txt",
		expectedContent: "Configuration file: src/settings.ts\n",
	}),
});
