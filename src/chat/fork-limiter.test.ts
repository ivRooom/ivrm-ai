import { expect, it } from "vitest";
import { ForkLimiter } from "./fork-limiter.js";

it("bounds concurrent copies, minute bursts and daily storage amplification", () => {
  let at = 0;
  const limiter = new ForkLimiter(() => at);
  const first = limiter.acquire("alice");
  if (typeof first !== "function") throw Error("expected slot");
  expect(limiter.acquire("alice")).toBe(1);
  first();
  for (let i = 1; i < 6; i++) {
    const release = limiter.acquire("alice");
    if (typeof release !== "function") throw Error("expected slot");
    release();
  }
  expect(limiter.acquire("alice")).toBe(60);
  for (let i = 6; i < 50; i++) {
    at += 60_000;
    const release = limiter.acquire("alice");
    if (typeof release !== "function") throw Error("expected slot");
    release();
  }
  at += 60_000;
  expect(limiter.acquire("alice")).toBeGreaterThan(60);
  at = 86_400_000;
  expect(typeof limiter.acquire("alice")).toBe("function");
});

it("does not grow without bound or evict another owner's active quota", () => {
  const limiter = new ForkLimiter(() => 0);
  for (let i = 0; i < 1024; i++)
    expect(typeof limiter.acquire(String(i))).toBe("function");
  expect(limiter.acquire("overflow")).toBe(60);
  expect(limiter.acquire("0")).toBe(1);
});
