export function firstAddress(value) {
  if (Array.isArray(value)) {
    const first = value.find((item) => {
      if (item && typeof item === "object") return item.IP || item.ip || item.Address || item.address;
      return item;
    });
    if (first && typeof first === "object") return first.IP || first.ip || first.Address || first.address || "";
    return first || "";
  }
  return value || "";
}
