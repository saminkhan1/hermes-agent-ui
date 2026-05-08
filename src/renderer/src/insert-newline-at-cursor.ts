/** Insert `\n` at the caret and fire `input` (for autosize listeners). */
export function insertNewlineAtCursor(textarea) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const value = textarea.value;
  textarea.value = value.slice(0, start) + '\n' + value.slice(end);
  const pos = start + 1;
  textarea.selectionStart = textarea.selectionEnd = pos;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}
