/** Only selected text is passed here. Known credentials never enter assistant state. */
export function redactAiContext(text: string, secrets: readonly string[] = []): string {
  let safe = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
  for (const secret of secrets) if (secret) safe = safe.split(secret).join("[已隐藏凭据]");
  return safe;
}

/** Read only a selection entirely contained in one explicitly allowed log surface. */
export function selectedAiContext(selector: string, secrets: readonly string[] = []): string {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return "";
  const range = selection.getRangeAt(0);
  const allowed = Array.from(document.querySelectorAll(selector)).some(element =>
    element.contains(range.startContainer) && element.contains(range.endContainer));
  if (!allowed) return "";
  const raw = selection.toString();
  if (new TextEncoder().encode(raw).length > 32000 || /PRIVATE KEY|otpauth(?:-migration)?:\/\//i.test(raw)) return "";
  const text = redactAiContext(raw, secrets).split("\n").map(line => {
    const labelled = /(?:password|passwd|passphrase|secret|api[_-]?key|access[_-]?key|authorization|cookie|token|密码|密钥|口令|验证码种子)["'\s]*[:=：]/i.test(line);
    const urlCredential = /https?:\/\/[^\s/@]+(?::[^\s/@]*)?@/i.test(line);
    return labelled || urlCredential ? "[已移除可能含凭据的行]" : line;
  }).join("\n");
  return new TextEncoder().encode(text).length <= 32000 ? text : "";
}
