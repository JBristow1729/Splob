export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function fittedTextStyle(value, baseLength = 13, minScale = 0.72) {
  const length = String(value || "").trim().length;
  const scale = length > baseLength ? Math.max(minScale, baseLength / length) : 1;
  return `style="--text-fit-scale:${scale}"`;
}
