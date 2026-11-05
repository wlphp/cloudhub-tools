const rememberedMemberEmailKey = "cloudhub-tools-member-email";

function isValidMemberEmail(value: string) {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function readRememberedMemberEmail() {
  try {
    const value = localStorage.getItem(rememberedMemberEmailKey) ?? "";
    return isValidMemberEmail(value) ? value : "";
  } catch { return ""; }
}

export function rememberMemberEmail(value: string) {
  const email = value.trim().toLowerCase();
  if (!isValidMemberEmail(email)) return;
  try { localStorage.setItem(rememberedMemberEmailKey, email); } catch { /* Email remembering is optional when storage is unavailable. */ }
}
