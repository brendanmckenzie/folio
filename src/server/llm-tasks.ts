/**
 * The model each LLM task uses, read from `llm-tasks.json` and nowhere else
 * (Operate O36/O37). The registry is also what the model watch reads, so a model
 * id written in source instead is a task the watch cannot see.
 *
 * `TASK_IDS` is the type: add a task to the JSON and to this list, and
 * `test/unit/llm-registry.test.ts` fails until both agree.
 */
import registry from "./llm-tasks.json";

export const TASK_IDS = ["media.describe"] as const;
export type TaskId = (typeof TASK_IDS)[number];

export interface LlmTask {
  id: TaskId;
  purpose: string;
  vendor: string;
  model: string;
  line: string;
  candidateLines: string[];
  prompt: string;
  tools: string | null;
  eval: string | null;
  evalGapIssue: number | null;
  budget: { monthlyUsd: number; killSwitch: string | null } | null;
}

/** The registry entry for a task. An unknown id is a type error, and a throw if forced. */
export function task(id: TaskId): LlmTask {
  const found = (registry.tasks as LlmTask[]).find((t) => t.id === id);
  if (!found) throw new Error(`llm-tasks.json has no task "${id}"`);
  return found;
}

export function taskModel(id: TaskId): string {
  return task(id).model;
}
