export function rectForEvalElement(el: any, { includeHidden = false } = {}) {
  if (!(el instanceof HTMLElement)) return null;
  if (!includeHidden && (el.hidden || window.getComputedStyle(el).display === 'none')) return null;
  const rect = el.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  const wx = window.screenX ?? window.screenLeft ?? 0;
  const wy = window.screenY ?? window.screenTop ?? 0;
  return {
    left: Math.round(wx + rect.left),
    top: Math.round(wy + rect.top),
    right: Math.round(wx + rect.right),
    bottom: Math.round(wy + rect.bottom),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

export function activeElementForEval(activeElement = document.activeElement) {
  return activeElement ? { id: activeElement.id || '', tag: activeElement.tagName || '' } : null;
}

export function visibleTextForEval({ root = document.body, maxPreviewLength = 4000 } = {}) {
  const visibleText = root && typeof root.innerText === 'string'
    ? root.innerText.replace(/\s+/g, ' ').trim()
    : '';
  return {
    visibleTextLength: visibleText.length,
    visibleTextPreview: visibleText.slice(0, maxPreviewLength),
  };
}
