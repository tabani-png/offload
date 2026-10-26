// The person names in the fixtures (gen-domains.ts personas, gen.ts founder week, sent-mail.ts), copied so the tests
// can check that none of them is readable in a stored note, a description or a model request.
export const FIXTURE_FIRST = [
  // gen-domains.ts FIRST + TEAM
  "Amara", "Bilal", "Chen", "Dara", "Elif", "Farah", "Goran", "Hana", "Ivan", "Jonas", "Keiko", "Lena", "Mateo", "Nia", "Omar", "Priya", "Quinn", "Rosa", "Sven", "Tariq", "Uma", "Viktor", "Wen", "Yara", "Zane",
  "Sam", "Ana", "Kofi", "Lea", "Raj",
  // gen.ts FIRST + TEAM
  "Jane", "Lucas", "Mei", "Daniel", "Sara", "Tom", "Aisha", "Ben", "Chloe", "Ravi", "Elena", "Marco", "Nina", "Laura", "Jordan", "Alex", "Riley",
  // sent-mail.ts
  "Anna", "James", "Sofia", "David", "Rachel", "Marc", "Clara", "Julia", "Leo", "Hannah", "Peter", "Kemi", "Muhammad",
];
export const FIXTURE_LAST = [
  "Okafor", "Haddad", "Novak", "Silva", "Lindqvist", "Mensah", "Petrov", "Tanaka", "Moreau", "Kowalski", "Ibrahim", "Fischer", "Rossi", "Nakamura", "Osei", "Varga", "Dubois", "Kaya", "Larsen", "Reyes",
  "Doe", "Raman", "Berg", "Khan", "Meyer", "Adeyemi", "Weber", "Patel",
];

/** A map's placeholders without its random run tag (<person:qzkt.1> -> <person:1>), so a test can state the numbering. */
export const untag = (s: string) => s.replace(/<person:[a-z]{4}\./g, "<person:");
/** The run tag of the placeholders in `s` ("qzkt"), "" when there are none. */
export const tagOf = (s: string) => /<person:([a-z]{4})\./.exec(s)?.[1] ?? "";
/** A fake model's reply written with untagged placeholders (<person:1>), in the tag of the prompt it answers. */
export const retag = (reply: string, prompt: string) => reply.replace(/<person:(?=\d|me)/g, `<person:${tagOf(prompt)}.`);

const re = (n: string) => new RegExp(`(?<![\\p{L}\\p{N}_])${n}(?![\\p{L}\\p{N}_])`, "u");
const cache = new Map<string, RegExp>();

/** The fixture names readable in `text` (whole words, as written). */
export function readableNames(text: string, names: readonly string[] = [...FIXTURE_FIRST, ...FIXTURE_LAST]): string[] {
  return names.filter((n) => {
    let r = cache.get(n);
    if (r === undefined) cache.set(n, (r = re(n)));
    return r.test(text);
  });
}

export function readable(text: string, names: readonly string[]): boolean {
  return readableNames(text, names).length > 0;
}
