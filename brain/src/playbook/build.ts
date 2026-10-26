// Build one workflow's playbook: identity -> threads -> per-message reads (Haiku) -> counts (code) -> baseline (code)
// -> wording (Opus) -> de-personalisation check (fail closed) -> playbook.json + PLAYBOOK.md.
import { TIER_MODELS } from "../models/router.ts";
import type { Model } from "../models/model.ts";
import { loadTonePack, type TonePack } from "../tone/pack.ts";
import { readText } from "../workflows/store.ts";
import type { WorkflowJson } from "../workflows/types.ts";
import { assertDepersonalised } from "./leak.ts";
import { buildIdentity, type Identity } from "./mask.ts";
import { readMessages, threadMessages } from "./read.ts";
import { computeCadence, computeOutcomes, computeStats } from "./stats.ts";
import { baselinePlaybook, synthesise } from "./synth.ts";
import { readPlaybook, writePlaybook } from "./store.ts";
import { MIN_MESSAGES, PLAYBOOK_SCHEMA, type Channel, type MessageRead, type Playbook, type PlaybookMessage } from "./types.ts";

/** Not enough to learn from (no tone pack, too few messages): the API answers 409. */
export class PlaybookInputError extends Error {}

export interface BuildPlaybookOptions {
  workflowId: string;
  channel: Channel;
  /** Every message of the threads (opening messages, follow-ups, replies): replies count as thread state. */
  messages: readonly PlaybookMessage[];
  /** The messages to read; default all. */
  readIds?: ReadonlySet<string>;
  /** facts.md of the workflow: the author's `sign:` and `company:` join the identity set. */
  facts?: string;
  /** null = rules only (no model call). */
  model: Model | null;
  /** Labeller calls at most (default MAX_LABEL_CALLS). */
  maxLabelCalls?: number;
  now: number;
  previous?: Playbook | null;
}

export interface BuildPlaybookResult {
  playbook: Playbook;
  reads: MessageRead[];
  identity: Identity;
  /** Every prompt sent to a model (tests check they are masked). */
  prompts: string[];
}

export async function buildPlaybook(o: BuildPlaybookOptions): Promise<BuildPlaybookResult> {
  const identity = buildIdentity(o.messages, o.facts ?? "");
  const threaded = threadMessages(o.messages).filter((t) => o.readIds === undefined || o.readIds.has(t.message.id));
  if (threaded.length < MIN_MESSAGES) throw new PlaybookInputError(`a playbook needs at least ${MIN_MESSAGES} sent messages of this workflow (found ${threaded.length})`);
  const { reads, prompts, warnings } = await readMessages(threaded, identity, o.model, o.maxLabelCalls);
  const stats = computeStats(reads);
  const outcomes = computeOutcomes(reads);
  const cadence = computeCadence(reads, o.messages);
  const base = baselinePlaybook(reads, stats, outcomes, cadence);
  const synth = await synthesise(base, stats, outcomes, cadence, identity, o.model);
  if (synth.prompt !== null) prompts.push(synth.prompt);
  const prev = o.previous ?? null;
  const version = (prev?.version ?? 0) + 1;
  const playbook: Playbook = {
    schema: PLAYBOOK_SCHEMA,
    version,
    workflowId: o.workflowId,
    channel: o.channel,
    builtAt: o.now,
    sources: { messages: reads.length, threads: new Set(reads.map((r) => r.threadKey)).size },
    message: synth.text.message,
    rules: synth.text.rules,
    templates: synth.text.templates,
    skeletons: synth.text.skeletons,
    cadence,
    avoid: synth.text.avoid,
    stats,
    outcomes,
    notes: prev?.notes ?? "",
    history: [...(prev?.history ?? []), { version, at: o.now, change: "built" as const }].slice(-50),
    models: { label: reads.some((r) => r.labelledBy === "model") ? TIER_MODELS.haiku : "rules", synth: TIER_MODELS.opus, synthUsed: synth.used },
    warnings: [...warnings, ...(synth.warning === null ? [] : [synth.warning])],
  };
  assertDepersonalised(playbook, identity);
  return { playbook, reads, identity, prompts };
}

/** A tone pack corpus as playbook messages, and the ids to read for a workflow of `bucket`: its own messages and the
 * follow-ups in threads it opened. Other messages of those threads (replies) are kept as thread state. */
export function workflowMessages(pack: TonePack, bucket: string): { messages: PlaybookMessage[]; readIds: Set<string> } {
  const all: PlaybookMessage[] = pack.corpus.map((e) => ({ id: e.id, channel: "email", to: [...e.to], subject: e.subject, body: e.text, sentAt: e.sentAt, bucket: e.bucket }));
  const threaded = threadMessages(all);
  const keys = new Set(threaded.filter((t) => t.message.bucket === bucket).map((t) => t.threadKey));
  const opened = new Set(threaded.filter((t) => t.message.bucket === bucket && t.role === "first_touch").map((t) => t.threadKey));
  const inThreads = threaded.filter((t) => keys.has(t.threadKey));
  const readIds = new Set(inThreads.filter((t) => t.message.bucket === bucket || (t.role === "follow_up" && opened.has(t.threadKey))).map((t) => t.message.id));
  return { messages: inThreads.map((t) => t.message), readIds };
}

/** The identity set of a workflow now: its tone pack threads (when the pack is still there) and facts.md. */
export function identityForWorkflow(home: string, wf: WorkflowJson, now: number): Identity {
  const pack = loadTonePack(home, now);
  const messages = pack === null ? [] : workflowMessages(pack, wf.bucket).messages;
  return buildIdentity(messages, readText(home, wf.id, "facts.md") ?? "");
}

/** POST /workflows/:id/playbook {action: "build"}: from the sealed tone pack, written to the workflow folder. */
export async function buildWorkflowPlaybook(home: string, wf: WorkflowJson, model: Model, now: number): Promise<Playbook> {
  const pack = loadTonePack(home, now);
  if (pack === null || pack.corpus.length === 0) throw new PlaybookInputError("no tone pack yet: run `tone build` so Offload can read your sent messages");
  const { messages, readIds } = workflowMessages(pack, wf.bucket);
  const { playbook } = await buildPlaybook({ workflowId: wf.id, channel: "email", messages, readIds, facts: readText(home, wf.id, "facts.md") ?? "", model, now, previous: readPlaybook(home, wf.id) });
  writePlaybook(home, playbook);
  return playbook;
}
