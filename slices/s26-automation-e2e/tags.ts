// s26 verify helper: per-tag pass / fail counts from a bun JUnit report. Usage: bun tags.ts REPORT "TAG TAG ..."
const xml = await Bun.file(process.argv[2]).text();
const want = process.argv[3].split(" ");
const re = /<testcase ([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
const pass = Object.fromEntries(want.map((t) => [t, 0]));
const bad = Object.fromEntries(want.map((t) => [t, 0]));
let total = 0, skipped = 0;
for (const m of xml.matchAll(re)) {
  total++;
  const name = /name="([^"]*)"/.exec(m[1])?.[1] ?? "";
  const tag = /^([A-Z]+): /.exec(name)?.[1];
  const body = m[3] ?? "";
  const ok = m[2] === "/>" || !/<(failure|error|skipped)/.test(body);
  if (/<skipped/.test(body)) skipped++;
  if (tag === undefined || !(tag in pass)) continue;
  if (ok) pass[tag]++; else bad[tag]++;
}
console.log(`total ${total} skipped ${skipped}`);
for (const t of want) console.log(`${t} ${pass[t]} ${bad[t]}`);

