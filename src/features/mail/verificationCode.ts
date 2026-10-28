const codePattern = /(?<![A-Z0-9])(?=[A-Z0-9]{4,10}(?![A-Z0-9]))(?=[A-Z0-9]*\d)[A-Z0-9]{4,10}/gi;
const hintPattern = /验证码|校验码|动态码|安全码|登录码|确认码|验证代码|verification[\s-]*code|verification\s+pin|security\s+code|one[\s-]?time(?:\s+password|\s+code)?|\botp\b|passcode|login\s+code|your\s+(?:verification\s+)?code/gi;

/** Returns a uniquely, context-supported one-time code; avoids guessing from unrelated numbers. */
export function extractVerificationCode(...sources: string[]): string | null {
  const text = sources.join("\n").normalize("NFKC");
  const hints = [...text.matchAll(hintPattern)].map(match => ({ start: match.index!, end: match.index! + match[0].length }));
  if (!hints.length) return null;

  const candidates = new Map<string, number>();
  for (const match of text.matchAll(codePattern)) {
    const start = match.index!;
    const end = start + match[0].length;
    const distance = Math.min(...hints.map(hint => Math.max(0, hint.start - end, start - hint.end)));
    if (distance <= 48) candidates.set(match[0].toUpperCase(), Math.min(distance, candidates.get(match[0].toUpperCase()) ?? Infinity));
  }
  if (!candidates.size) return null;

  const nearest = Math.min(...candidates.values());
  const best = [...candidates].filter(([, distance]) => distance === nearest);
  return best.length === 1 ? best[0][0] : null;
}
