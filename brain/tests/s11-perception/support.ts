// Writes keyframes in the engine's on-disk format (engine/Sources/OffloadCore/Store/FrameStore.swift) with raw
// OFFLOAD_KEYS=file day keys, so brain tests run without the Swift binary. The XL tests check the same format against
// frames written by the real engine.
import { createCipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { encryptLine } from "../../src/store/crypto.ts";
import { localDay } from "../../src/store/vault.ts";
import type { FrameRef } from "../../src/vision/types.ts";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let counter = 0;

export function ulid(ts: number): string {
  let t = ts;
  let s = "";
  for (let i = 0; i < 10; i++) {
    s = CROCKFORD[t % 32]! + s;
    t = Math.floor(t / 32);
  }
  counter += 1;
  let r = "";
  let c = counter;
  for (let i = 0; i < 16; i++) {
    r = CROCKFORD[c % 32]! + r;
    c = Math.floor(c / 32);
  }
  return s + r;
}

export function dayKey(home: string, day: string): Buffer {
  const dir = join(home, "keys");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = join(dir, `${day}.key`);
  if (!existsSync(p)) writeFileSync(p, randomBytes(32), { mode: 0o600 });
  return readFileSync(p);
}

export function sealBlob(key: Buffer, frameId: string, data: Buffer): Buffer {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(Buffer.from(`offload/frame/v1/${frameId}`, "utf8"));
  const ct = Buffer.concat([c.update(data), c.final()]);
  return Buffer.concat([nonce, ct, c.getAuthTag()]);
}

/** Writes one frame (blob + index line) and returns its FrameRef. */
export function writeFrame(home: string, ts: number, data: Buffer = Buffer.from(`jpeg-${ts}-${counter}`), over: Partial<FrameRef> = {}): FrameRef {
  const day = localDay(ts);
  const key = dayKey(home, day);
  const frameId = over.frameId ?? ulid(ts);
  const dir = join(home, "frames", day);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, `${frameId}.enc`), sealBlob(key, frameId, data), { mode: 0o600 });
  const meta = { frameId, ts, app: over.app ?? "com.google.Chrome", appName: over.appName ?? "Google Chrome", host: over.host ?? "app.example.test", phash: "0123456789abcdef", width: 1280, height: 800, bytes: data.length, maskedRegions: 0 };
  appendFileSync(join(dir, "index.jsonl.enc"), encryptLine(key, JSON.stringify(meta)) + "\n", { mode: 0o600 });
  return { ...meta, day };
}

/** A fake observer for list-frames / export-frame in keychain mode: serves files written by writeFrame, logs its
 * environment, and exits 3 for days listed in FAKE_EXPIRED. */
export function fakeFrameObserver(dir: string): string {
  const p = join(dir, "fake-frames-observer.sh");
  writeFileSync(
    p,
    `#!/bin/bash
env > "${dir}/env.log"
cmd="$1"; arg="$2"; home="$OFFLOAD_HOME"
case "$cmd" in
  list-frames)
    [ -f "$home/expired-$arg" ] && { echo "expired" >&2; exit 3; }
    f="$home/frames/$arg/plain-index.jsonl"; [ -f "$f" ] && cat "$f"; exit 0 ;;
  export-frame)
    f="$(ls "$home"/frames/*/"$arg".jpg 2>/dev/null | head -1)"; [ -n "$f" ] || { echo "not found" >&2; exit 1; }
    cat "$f"; exit 0 ;;
esac
exit 2
`,
    { mode: 0o755 },
  );
  return p;
}
