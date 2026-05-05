export function normaliseSkuPart(value, fallback = "na") {
  if (!value) return fallback;
  const cleaned = value
    .toString()
    .trim()
    .toLowerCase()
    // SKU parts must be URL/file-safe and slash-free.
    // e.g. WHITE/SILVER -> whitesilver, BLACK/ANTHRACITE -> blackanthracite
    .replace(/[^a-z0-9]+/g, "");
  return cleaned || fallback;
}

export function normalizeSize(sizeValue) {
  if (!sizeValue) return "na";
  const rawSize = sizeValue.toString().trim();
  if (!rawSize) return "na";
  const normalizedKey = rawSize.toLowerCase().replace(/\s+/g, " ").trim();
  const directMap = {
    small: "s", s: "s", medium: "m", m: "m", large: "l", l: "l",
    xl: "xl", "2xl": "2xl", "3xl": "3xl", "4xl": "4xl", "5xl": "5xl",
    "3xs": "3xs", "2xs": "2xs", xs: "xs",
    default: "one", "default title": "one", "one size": "one",
    onesize: "one", "one-size": "one",
    jnr: "jnr", snr: "snr",
  };
  if (directMap[normalizedKey]) return directMap[normalizedKey];
  let working = normalizedKey;
  [{ from: "small", to: "s" }, { from: "medium", to: "m" }, { from: "large", to: "l" }].forEach(({ from, to }) => {
    working = working.replace(new RegExp(`\\b${from}\\b`, "g"), to);
  });
  working = working.replace(/\buk\b/g, "").replace(/\s+/g, " ").trim().replace(/\s+/g, "-").replace(/\./g, "_").replace(/-+/g, "-");
  return working || "na";
}

export function generateVariantSku({ model, colour, size }) {
  return `${normaliseSkuPart(model)}-${normaliseSkuPart(colour)}-${normalizeSize(size)}`;
}
