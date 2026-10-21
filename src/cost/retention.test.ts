import { describe, expect, it } from "vitest";
import { cutoffMonth } from "./retention.js";

describe("cutoffMonth", () => {
  it.each([
    ["2026-10-21T03:00:00Z", 3, "2026-08"],
    ["2026-02-10T00:00:00Z", 3, "2025-12"],
    ["2026-01-05T00:00:00Z", 2, "2025-12"],
    ["2026-10-21T03:00:00Z", 13, "2025-10"],
    // 2026-10-31 16:00 UTC is already November in Japan.
    ["2026-10-31T16:00:00Z", 3, "2026-09"],
  ])("%s keeping %i months -> %s", (now, keep, expected) => {
    expect(cutoffMonth(new Date(now), keep)).toBe(expected);
  });

  it("keeps at least the current and the previous month", () => {
    expect(() => cutoffMonth(new Date(), 1)).toThrow();
    expect(() => cutoffMonth(new Date(), 2.5)).toThrow();
  });
});
