import { describe, expect, it } from "vitest";
import {
  canSubmitComposer,
  composerRowsForContent,
  shouldSubmitComposer,
} from "./composer.js";

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

describe("canSubmitComposer", () => {
  it("requires non-empty text and an available selected model", () => {
    expect(canSubmitComposer("hello", "model-a", true)).toBe(true);
    expect(canSubmitComposer("  ", "model-a", true)).toBe(false);
    expect(canSubmitComposer("hello", "", true)).toBe(false);
    expect(canSubmitComposer("hello", "model-a", false)).toBe(false);
  });
});

describe("composerRowsForContent", () => {
  it("grows for wrapped content and respects minimum and maximum rows", () => {
    expect(composerRowsForContent(33, 22, 11, 38)).toBe(1);
    expect(composerRowsForContent(55, 22, 11, 38)).toBe(2);
    expect(composerRowsForContent(165, 22, 11, 38)).toBe(6);
  });

  it("falls back to one row for invalid measurements", () => {
    expect(composerRowsForContent(100, 0, 11, 38)).toBe(1);
  });
});

describe("shouldSubmitComposer", () => {
  it("submits on Enter", () => {
    expect(shouldSubmitComposer(key())).toBe(true);
  });

  it("keeps Ctrl/Cmd+Enter compatible", () => {
    expect(shouldSubmitComposer(key({ ctrlKey: true }))).toBe(true);
    expect(shouldSubmitComposer(key({ metaKey: true }))).toBe(true);
  });

  it("leaves Shift+Enter for a newline", () => {
    expect(shouldSubmitComposer(key({ shiftKey: true }))).toBe(false);
  });

  it("keeps Ctrl/Cmd+Shift+Enter compatible", () => {
    expect(shouldSubmitComposer(key({ shiftKey: true, ctrlKey: true }))).toBe(
      true
    );
    expect(shouldSubmitComposer(key({ shiftKey: true, metaKey: true }))).toBe(
      true
    );
  });

  it("does not submit while an IME composition is active", () => {
    expect(shouldSubmitComposer(key({ isComposing: true }))).toBe(false);
    expect(shouldSubmitComposer(key({ keyCode: 229 }))).toBe(false);
  });

  it("ignores other keys", () => {
    expect(shouldSubmitComposer(key({ key: "Escape" }))).toBe(false);
  });
});
