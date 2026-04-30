/**
 * Claude vision second-stage colour classifier.
 *
 * Given a product image URL and the list of colourways Macron makes that product
 * in, asks Claude to pick the right colour, ignoring club badges / sponsors /
 * personalisation overlays.
 *
 * Results are cached on disk by image-URL hash so each image costs ~$0.005 once.
 *
 * Requires env var: ANTHROPIC_API_KEY  (https://console.anthropic.com)
 *
 * If the key is not set, this module no-ops and returns null — the rest of the
 * app continues working with dHash only.
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const CACHE_PATH = path.join(process.cwd(), "app", "data", "visionCache.json");
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-5";

let cache = null;
async function loadCache() {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(CACHE_PATH, "utf8");
    cache = JSON.parse(raw);
  } catch {
    cache = {};
  }
  return cache;
}

async function saveCache() {
  if (!cache) return;
  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await fs.writeFile(CACHE_PATH, JSON.stringify(cache, null, 2));
}

function cacheKey(imageUrl, allowedColours) {
  const sig = `${imageUrl}|${(allowedColours ?? []).slice().sort().join(",")}`;
  return crypto.createHash("sha1").update(sig).digest("hex");
}

export function isVisionLlmEnabled() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * Asks Claude vision: "ignoring any club badges/sponsors/personalisation, which
 * of these Macron colourways is this garment?" Returns the chosen colour string
 * (must be one of allowedColours), or null if Claude refuses / errors.
 */
export async function classifyColourWithClaude(imageUrl, allowedColours, productName = null) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !imageUrl || !allowedColours?.length) return null;

  await loadCache();
  const key = cacheKey(imageUrl, allowedColours);
  if (cache[key]) return cache[key];

  // Fetch image and base64-encode it (Claude vision accepts base64 or URL — base64
  // is more reliable in case the image host needs auth/headers).
  let imageMedia;
  try {
    const r = await fetch(imageUrl);
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    const contentType = r.headers.get("content-type") || "image/jpeg";
    imageMedia = {
      type: "base64",
      media_type: contentType.split(";")[0].trim(),
      data: buf.toString("base64"),
    };
  } catch {
    return null;
  }

  const productLine = productName ? `It's a Macron ${productName}.` : "";
  const prompt = `${productLine}
Look at the garment colour, IGNORING any printed club logos, sponsor names, player numbers, embroidery, or other personalisation overlays. Focus on the base fabric colour of the garment itself.

Which of these Macron colourways is it? Respond with EXACTLY one of the following names, nothing else:
${allowedColours.map((c) => `- ${c}`).join("\n")}

If you can't tell with high confidence, respond with: UNKNOWN`;

  let body;
  try {
    const r = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 50,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: imageMedia },
              { type: "text", text: prompt },
            ],
          },
        ],
      }),
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      console.warn(`[vision-llm] HTTP ${r.status}: ${errText.slice(0, 200)}`);
      return null;
    }
    body = await r.json();
  } catch (err) {
    console.warn(`[vision-llm] fetch failed: ${err.message}`);
    return null;
  }

  const text = (body?.content?.[0]?.text || "").trim();
  if (!text || /unknown/i.test(text)) {
    cache[key] = null;
    await saveCache();
    return null;
  }

  // Find the closest allowed colour to what Claude said
  const upper = text.toUpperCase();
  const exact = allowedColours.find((c) => c.toUpperCase() === upper);
  const partial =
    exact ||
    allowedColours.find((c) => upper.includes(c.toUpperCase())) ||
    allowedColours.find((c) => c.toUpperCase().includes(upper));

  const result = partial || null;
  cache[key] = result;
  await saveCache();
  return result;
}
