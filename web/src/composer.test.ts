import { describe, expect, it } from "vitest";
import { shouldSubmitComposer } from "./composer.js";

function key(values: Partial<Parameters<typeof shouldSubmitComposer>[0]> = {}) {
  return {
    key: "Enter",
    shiftKey: false,
    isComposing: false,
    keyCode: 13,
    ctrlKey: false,
    metaKey: false,
    ...values,
  };
}

describe("shouldSubmitComposer", () => {
  it("submits on Enter and keeps Ctrl/Cmd+Enter compatible", () => {
    expect(shouldSubmitComposer(key())).toBe(true);
  });

  it("keeps Ctrl/Cmd+Enter compatible", () => {
    expect(shouldSubmitComposer(key({ ctrlKey: true }))).toBe(true);
    expect(shouldSubmitComposer(key({ metaKey: true }))).toBe(true);
  });

  it("leaves Shift+Enter for a newline", () => {
    expect(shouldSubmitComposer(key({ shiftKey: true }))).toBe(false);
  });

  it("does not submit while an IME composition is active", () => {
    expect(shouldSubmitComposer(key({ isComposing: true }))).toBe(false);
    expect(shouldSubmitComposer(key({ keyCode: 229 }))).toBe(false);
  });

  it("ignores other keys", () => {
    expect(shouldSubmitComposer(key({ key: "Escape" }))).toBe(false);
  });
});
