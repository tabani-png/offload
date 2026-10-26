Recorded replies for the s24 tests (no live model call in the suite unless ANTHROPIC_API_KEY is set, live.test.ts).
- `check-writer.json`: a Sonnet `build_checks` reply (JSON `{file, content}`) for the slug brief, replayed through a
  fake router backend.
- `slug-good.py` / `slug-bad.py`: what the fake builder writes on a passing / failing try.
