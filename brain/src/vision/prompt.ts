// The captioning prompt (SPEC C5). Domain-agnostic on purpose: no example apps, industries or tasks that would pull
// every answer toward email. The model describes the WORK on the screen in the user's terms, as one internal note.
import { maskNamesForStorage } from "../privacy/names.ts";
import type { FrameRef, UserContext } from "./types.ts";

export const SYSTEM_PROMPT = `You look at one screenshot of a person's computer screen and write a short structured note about the work they are doing in it. The note is private, stays on this computer, and is used later to spot work that repeats.

Rules:
- Describe what the person is doing, not what the software is. Use plain words from the screen itself.
- Only state what is visible. Do not guess names, numbers or ids that you cannot read. Use an empty string or an empty list when a field is not visible.
- Black rectangles are redacted areas. Ignore them and never guess what they hide.
- Do not copy long passages of text. Short labels and ids are fine.
- Answer with JSON only, matching the schema.

Fields:
- activity: one plain sentence, at most 25 words, starting with a verb in -ing form: what the person is doing. Be specific about the action: typing values into a form is "entering", writing text is "writing", changing a field is "updating"; use "reviewing" only when nothing is being changed.
- verb: one word for that action.
- object: the kind of thing being worked on, as a generic noun of 1 to 4 words.
- counterpart: the organisation the work is for or with, or the role of the person (a customer, a candidate, a supplier). Never a person's name. "" when not visible.
- surface: the name of the app or site as shown on screen, then the name of the screen or view.
- step: where in a process this looks to be, in a few words.
- inputs: up to 8 short labels for the kinds of information the person reads to do this step (labels, not the values).
- outputs: up to 8 short labels for what the person produces or changes in this step (labels, not the values).
- identifiers: up to 12 stable record ids exactly as shown (record or document numbers, file names, web domains). Not names of people, not headings, not sentences.
- confidence: 0 to 1, how sure you are about activity and object.`;

const clean = (s: string | undefined, max: number) => (s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** The user turn: the frame's app and host as hints, plus optional onboarding context. */
export function userPrompt(ref: FrameRef, context: UserContext = {}): string {
  const hints: string[] = [];
  const app = clean(ref.appName ?? ref.app, 80);
  if (app !== "") hints.push(`Frontmost app: ${app}.`);
  const host = clean(ref.host, 120);
  if (host !== "") hints.push(`Web site: ${host}.`);
  // s18: the onboarding context is free text; a person's name in it is not sent.
  const role = maskNamesForStorage(clean(context.role, 80));
  const industry = maskNamesForStorage(clean(context.industry, 80));
  if (role !== "" || industry !== "") hints.push(`The person describes their work as: ${[role, industry].filter((x) => x !== "").join(", ")}. Use it only to choose words; describe only what is on screen.`);
  return [...hints, "Write the JSON note for this screenshot."].join("\n");
}
