// s31: the brain inside Offload.app (Contents/Resources/offload/brain) finds the observer the app ships
// (Contents/MacOS/offload-observer) when nobody passes OFFLOAD_OBSERVER_BIN; a checkout keeps engine/.build.
import { describe, expect, test } from "bun:test";
import { pathToFileURL } from "node:url";
import { defaultObserverBin, observerBin } from "../../src/store/observer.ts";

const APP = "/Applications/Offload.app";
const inApp = pathToFileURL(`${APP}/Contents/Resources/offload/brain/src/store/observer.ts`).href;
const inRepo = pathToFileURL("/r/brain/src/store/observer.ts").href;

describe("s31 observer binary", () => {
  test("OBSBIN: bundled brain, no repo engine build -> the app's own Contents/MacOS/offload-observer", () => {
    const exists = (p: string) => p === `${APP}/Contents/MacOS/offload-observer`;
    expect(defaultObserverBin(inApp, exists)).toBe(`${APP}/Contents/MacOS/offload-observer`);
  });

  test("OBSBIN: a checkout keeps engine/.build/offload-observer (also when it is not built yet)", () => {
    expect(defaultObserverBin(inRepo, (p) => p === "/r/engine/.build/offload-observer")).toBe("/r/engine/.build/offload-observer");
    expect(defaultObserverBin(inRepo, () => false)).toBe("/r/engine/.build/offload-observer");
  });

  test("OBSBIN: a bundled brain with neither binary reports the repo-relative path (the error names it)", () => {
    expect(defaultObserverBin(inApp, () => false)).toBe(`${APP}/Contents/Resources/offload/engine/.build/offload-observer`);
  });

  test("OBSBIN: OFFLOAD_OBSERVER_BIN still wins", () => {
    expect(observerBin({ OFFLOAD_OBSERVER_BIN: "/x/obs" })).toBe("/x/obs");
  });
});
