export type ComposerKeyEvent = Pick<
  KeyboardEvent,
  "key" | "shiftKey" | "isComposing" | "keyCode" | "ctrlKey" | "metaKey"
>;

/** Whether the draft can be sent with the currently available model selection. */
export function canSubmitComposer(
  text: string,
  modelId: string,
  hasAvailableModel: boolean
): boolean {
  return text.trim().length > 0 && modelId.length > 0 && hasAvailableModel;
}

/** Calculate a bounded textarea row count from its measured wrapped content. */
export function composerRowsForContent(
  scrollHeight: number,
  lineHeight: number,
  verticalPadding: number,
  minHeight: number,
  maxRows = 6
): number {
  if (!Number.isFinite(lineHeight) || lineHeight <= 0 || maxRows < 1) return 1;
  const contentHeight = Math.max(0, scrollHeight - verticalPadding);
  const singleRowHeight = Math.max(lineHeight, minHeight - verticalPadding);
  const extraRows = Math.ceil(
    Math.max(0, contentHeight - singleRowHeight) / lineHeight
  );
  return Math.min(maxRows, 1 + extraRows);
}

/**
 * Enter sends, Shift+Enter inserts a line break. Ignore IME confirmation keys;
 * Ctrl/Cmd+Enter continues to send for people used to the existing shortcut.
 */
export function shouldSubmitComposer(event: ComposerKeyEvent): boolean {
  return (
    event.key === "Enter" &&
    (!event.shiftKey || event.ctrlKey || event.metaKey) &&
    !event.isComposing &&
    event.keyCode !== 229
  );
}
