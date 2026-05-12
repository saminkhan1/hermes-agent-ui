/** Insert `\n` at the caret and fire `input` (for autosize listeners). */
export function insertNewlineAtCursor(textarea: any) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  textarea.setRangeText('\n', start, end, 'end');
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}
