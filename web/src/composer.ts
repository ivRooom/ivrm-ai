export type ComposerKeyEvent = Pick<
  KeyboardEvent,
  "key" | "shiftKey" | "isComposing" | "keyCode" | "ctrlKey" | "metaKey"
>;

/**
 * Enter sends, Shift+Enter inserts a line break. Ignore IME confirmation keys;
 * Ctrl/Cmd+Enter continues to send for people used to the existing shortcut.
 */
export function shouldSubmitComposer(event: ComposerKeyEvent): boolean {
  return (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.isComposing &&
    event.keyCode !== 229
  );
}
