/** 路由拓扑与实时请求列表共用的供应商色标：名称哈希成固定颜色和首字母。 */
export function providerAccent(seed: string): { color: string; letter: string } {
  const trimmed = seed.trim() || "?";
  let hash = 0;
  for (let index = 0; index < trimmed.length; index += 1) hash = (hash * 31 + trimmed.charCodeAt(index)) >>> 0;
  const hue = hash % 360;
  const letter = /[A-Za-z0-9]/.test(trimmed) ? trimmed[0].toUpperCase() : "?";
  return { color: `hsl(${hue}, 55%, 42%)`, letter };
}
