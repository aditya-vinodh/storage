import { describe, expect, it } from "vitest";
import { mapLimit } from "./transfer.js";

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("mapLimit", () => {
  it("keeps order and never runs more than the limit at once", async () => {
    let running = 0;
    let peak = 0;
    const result = await mapLimit([5, 1, 4, 2, 3], 2, async (n) => {
      running += 1;
      peak = Math.max(peak, running);
      await tick(n);
      running -= 1;
      return n * 10;
    });
    expect(result).toEqual([50, 10, 40, 20, 30]);
    expect(peak).toBe(2);
  });

  it("starts nothing new after a failure and rejects only once in-flight calls finish", async () => {
    const started: number[] = [];
    const finished: number[] = [];
    const run = mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      started.push(n);
      if (n === 1) {
        throw new Error("boom");
      }
      await tick(20);
      finished.push(n);
      return n;
    });
    await expect(run).rejects.toThrow("boom");
    expect(started).toEqual([1, 2]);
    expect(finished).toEqual([2]);
  });
});
