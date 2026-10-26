// s30 verify: a bun test preload that moves the whole test process's clock to S30_FAKE_NOW (ISO time). The clock-pinned
// test files must pass at any date, not only within a week of their fixture day.
import { setSystemTime } from "bun:test";

const at = process.env.S30_FAKE_NOW;
if (at !== undefined && at !== "") setSystemTime(new Date(at));
