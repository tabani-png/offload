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
