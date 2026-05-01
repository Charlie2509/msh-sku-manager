import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { normalizeAllowedColours } from "./skuParser";

const CACHE_PATH = path.join(process.cwd(), "app", "data", "visionCache.json");
const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = process.env.OPENAI_VISION_MODEL || "gpt-4o-mini";

let cache = null;
async function loadCache() { if (cache) return cache; try { cache = JSON.parse(await fs.readFile(CACHE_PATH, "utf8")); } catch { cache = {}; } return cache; }
async function saveCache() { if (!cache) return; await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true }); await fs.writeFile(CACHE_PATH, JSON.stringify(cache, null, 2)); }
function cacheKey(imageUrl, allowedColours) { return crypto.createHash("sha1").update(`${imageUrl}|${(allowedColours ?? []).slice().sort().join(",")}`).digest("hex"); }

export function isVisionLlmEnabled() { return Boolean(process.env.OPENAI_API_KEY); }

export async function classifyColourWithVision(imageUrl, allowedColours, productName = null) {
  const apiKey = process.env.OPENAI_API_KEY;
  const normalizedAllowedColours = normalizeAllowedColours(allowedColours ?? []);
  if (!apiKey || !imageUrl || !normalizedAllowedColours.length) return null;
  await loadCache();
  const key = cacheKey(imageUrl, normalizedAllowedColours);
  if (Object.hasOwn(cache, key)) return cache[key];

  let imageDataUrl;
  try {
    const r = await fetch(imageUrl);
    if (!r.ok) { console.warn(`[vision-llm] Image HTTP ${r.status} for ${imageUrl}`); return null; }
    const contentType = (r.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
    const b64 = Buffer.from(await r.arrayBuffer()).toString("base64");
    imageDataUrl = `data:${contentType};base64,${b64}`;
  } catch (err) {
    console.warn(`[vision-llm] Image fetch failed: ${err.message}`);
    return null;
  }

  const productLine = productName ? `Product context: Macron ${productName}.` : "";
  const prompt = `${productLine}\nLook at the garment colour only. Ignore club badges, sponsors, player numbers, embroidery, logos, and personalisation overlays. Choose exactly one colour from the allowed list. If unsure, return UNKNOWN.\nAllowed colours:\n${normalizedAllowedColours.map((c) => `- ${c}`).join("\n")}\n\nRespond with exactly one allowed colour name or UNKNOWN. No explanation.`;

  try {
    const r = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_tokens: 20,
        messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: imageDataUrl } }] }],
      }),
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      console.warn(`[vision-llm] OpenAI HTTP ${r.status}: ${errText.slice(0, 200)}`);
      cache[key] = null; await saveCache(); return null;
    }
    const body = await r.json();
    const text = (body?.choices?.[0]?.message?.content || "").trim();
    const upper = text.toUpperCase();
    if (!text || upper === "UNKNOWN") { cache[key] = null; await saveCache(); return null; }
    const exact = normalizedAllowedColours.find((c) => c.toUpperCase() === upper);
    const partial = exact || normalizedAllowedColours.find((c) => upper.includes(c.toUpperCase())) || normalizedAllowedColours.find((c) => c.toUpperCase().includes(upper));
    const result = partial || null;
    cache[key] = result;
    await saveCache();
    return result;
  } catch (err) {
    console.warn(`[vision-llm] OpenAI request failed: ${err.message}`);
    return null;
  }
}

/**
 * Identify which Macron base model a product image corresponds to, given a list
 * of candidate models (each with a reference photo). Returns the chosen
 * model's slug + displayName, or null.
 *
 * candidateModels: [{ slug, displayName, imageUrl, category? }]
 *
 * The product image and each candidate reference are sent to OpenAI in one
 * call (multi-image request). The model is asked to ignore club badges and
 * sponsors and focus on garment shape, cut, and silhouette.
 */
export async function classifyModelWithVision(productImageUrl, candidateModels, productType = null) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !productImageUrl || !candidateModels?.length) return null;

  await loadCache();
  const candidateSlugs = candidateModels.map((c) => c.slug);
  const key = "model:" + crypto.createHash("sha1").update(`${productImageUrl}|${[...candidateSlugs].sort().join(",")}`).digest("hex");
  if (Object.hasOwn(cache, key)) return cache[key];

  // Fetch all images (product + candidates) and base64-encode
  async function toDataUrl(url) {
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      const ct = (r.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
      const b64 = Buffer.from(await r.arrayBuffer()).toString("base64");
      return `data:${ct};base64,${b64}`;
    } catch {
      return null;
    }
  }

  const productData = await toDataUrl(productImageUrl);
  if (!productData) return null;

  const candidateImages = [];
  for (const c of candidateModels) {
    const dataUrl = await toDataUrl(c.imageUrl);
    if (dataUrl) candidateImages.push({ ...c, dataUrl });
  }
  if (candidateImages.length === 0) return null;

  const typeLine = productType ? `The product is described as a "${productType}".` : "";
  const prompt = `${typeLine}
You are identifying which Macron base model this customised garment is.

The first image is the customer-customised product (it may have a club badge, sponsor name, player number, or embroidery overlaid on it — IGNORE all overlays).

The remaining images are reference photos of plain Macron base models. Each is labelled with a model name.

Look at the garment SHAPE, CUT, COLLAR, SLEEVE STYLE, PANEL SEAMS, HEM, and SILHOUETTE. Ignore the printed colour where the customised image differs from the reference (different clubs use different colours of the same base model).

Pick the ONE candidate model whose silhouette best matches the customer product. Reply with EXACTLY one of these model names, nothing else. If you cannot tell with reasonable confidence, reply UNKNOWN.

Candidate models:
${candidateImages.map((c, i) => `${i + 1}. ${c.displayName}`).join("\n")}`;

  const content = [
    { type: "text", text: prompt },
    { type: "text", text: "Product image (CUSTOMISED — ignore overlays):" },
    { type: "image_url", image_url: { url: productData, detail: "low" } },
  ];
  for (const c of candidateImages) {
    content.push({ type: "text", text: `Reference: ${c.displayName}` });
    content.push({ type: "image_url", image_url: { url: c.dataUrl, detail: "low" } });
  }

  try {
    const r = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_tokens: 30,
        messages: [{ role: "user", content }],
      }),
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      console.warn(`[vision-llm:model] OpenAI HTTP ${r.status}: ${errText.slice(0, 200)}`);
      cache[key] = null; await saveCache(); return null;
    }
    const body = await r.json();
    const text = (body?.choices?.[0]?.message?.content || "").trim();
    const upper = text.toUpperCase();
    if (!text || upper === "UNKNOWN") { cache[key] = null; await saveCache(); return null; }
    // Match the response to one of the candidates
    const exact = candidateImages.find((c) => c.displayName.toUpperCase() === upper);
    const partial = exact
      || candidateImages.find((c) => upper.includes(c.displayName.toUpperCase()))
      || candidateImages.find((c) => c.displayName.toUpperCase().includes(upper));
    const result = partial ? { slug: partial.slug, displayName: partial.displayName } : null;
    cache[key] = result;
    await saveCache();
    return result;
  } catch (err) {
    console.warn(`[vision-llm:model] OpenAI request failed: ${err.message}`);
    return null;
  }
}
