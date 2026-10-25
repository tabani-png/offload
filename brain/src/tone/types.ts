// Tone pack types (research doc section 4): Sent mail -> cleaned -> buckets -> style cards + retrieval corpus.

export interface SentEmail {
  id: string;
  to: string[];
  subject: string;
  /** Raw body as sent, possibly with quoted replies and a signature block. */
  body: string;
  sentAt: number;
}

export interface CleanEmail {
  id: string;
  to: string[];
  subject: string;
  sentAt: number;
  /** Cleaned body: greeting, core and sign-off, no quotes, no signature block. */
  text: string;
  /** Body without greeting and sign-off. */
  core: string;
  /** First line when it is a greeting, e.g. "Hi Anna,". */
  greeting: string | null;
  /** Closing word line before the name, e.g. "Thanks,"; null when the email ends with the name alone. */
  close: string | null;
  /** The name the email is signed with, e.g. "Muhammad". */
  signName: string | null;
}

export const BUCKETS = ["investor_outreach", "scheduling", "follow_up", "other"] as const;
export type Bucket = (typeof BUCKETS)[number];

export interface CorpusEntry extends CleanEmail {
  bucket: Bucket;
}
