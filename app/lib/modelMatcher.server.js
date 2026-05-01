/**
 * Model identification helpers.
 *
 * Given a parsed product (with its detected garment type) and product image,
 * find the most likely Macron base model by:
 *   1. Filtering candidate models by garment type (so we don't ask vision about
 *      hoodies when the product is clearly a sock).
 *   2. Optionally using dHash to bias the candidate list toward visually similar
 *      PIM products.
 *   3. Letting OpenAI vision pick the right one from a small candidate set.
 *
 * The reference model image lookup is built by scripts/build-model-image-index.mjs
 * (or the inline Python in chat) into app/data/modelImages.json.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { matchImage } from "./imageMatcher.server";

const INDEX_PATH = path.join(process.cwd(), "app", "data", "modelImages.json");
let cachedIndex = null;

export async function loadModelImages() {
  if (cachedIndex) return cachedIndex;
  try {
    cachedIndex = JSON.parse(await fs.readFile(INDEX_PATH, "utf8"));
  } catch {
    cachedIndex = {};
  }
  return cachedIndex;
}

/**
 * Map a parser-detected garment type (e.g. "COTTON TEE", "POLO SHIRT",
 * "TRAINING SWEATER", "HOODED TRACKSUIT TOP") to a broad family used to
 * filter candidate Macron models.
 */
export function broadGarmentFamily(parsedType) {
  if (!parsedType) return null;
  const t = parsedType.toUpperCase().trim();
  if (/POLO/.test(t)) return "polo";
  if (/HOOD/.test(t)) return "hoody";
  if (/(JACKET|COAT|BENCHCOAT|SHOWERJACKET)/.test(t)) return "jacket";
  if (/(TRACKSUIT|TRACK PANTS)/.test(t)) return "tracksuit";
  if (/SOCK/.test(t)) return "socks";
  if (/CAP|HAT|BOBBLE|POM|BEANIE/.test(t)) return "headwear";
  if (/(GLOVE)/.test(t)) return "gloves";
  if (/(BACKPACK|RUCKSACK|HOLDALL|BAG)/.test(t)) return "bag";
  if (/(BODY ?WARMER|GILET)/.test(t)) return "bodywarmer";
  if (/SHORTS/.test(t)) return "shorts";
  if (/(PANTS|TROUSERS|BOTTOMS)/.test(t)) return "trousers";
  if (/(SWEATER|SWEATSHIRT|JUMPER|FLEECE)/.test(t)) return "sweater";
  if (/(NECKWARMER|TUBULAR)/.test(t)) return "neckwarmer";
  if (/(TEE|T-SHIRT|SHIRT)/.test(t)) return "tee";
  if (/(BOTTLE)/.test(t)) return "accessory";
  return null;
}

/**
 * Same broad family from a Macron reference's stored garmentType (more reliable,
 * since this comes from the catalogue).
 */
function broadFamilyFromCategory(category) {
  if (!category) return null;
  const t = String(category).toUpperCase();
  if (/POLO/.test(t)) return "polo";
  if (/HOOD/.test(t)) return "hoody";
  if (/(JACKET|COAT|BENCHCOAT|SHOWERJACKET|RAINJACKET|RAIN JACKET|WINDBREAKER)/.test(t)) return "jacket";
  if (/TRACKSUIT/.test(t)) return "tracksuit";
  if (/SOCK/.test(t)) return "socks";
  if (/CAP|HAT|BOBBLE|POM|BEANIE/.test(t)) return "headwear";
  if (/GLOVE/.test(t)) return "gloves";
  if (/(BACKPACK|RUCKSACK|HOLDALL|BAG)/.test(t)) return "bag";
  if (/(BODY ?WARMER|GILET)/.test(t)) return "bodywarmer";
  if (/SHORT|BERMUDA/.test(t)) return "shorts";
  if (/(PANT|TROUSER|BOTTOM)/.test(t)) return "trousers";
  if (/(SWEATER|SWEATSHIRT|JUMPER|FLEECE)/.test(t)) return "sweater";
  if (/(TEE|T-SHIRT|MATCH DAY SHIRT|SHIRT)/.test(t)) return "tee";
  return null;
}

/**
 * Get up to N candidate Macron models for the given parsed garment type.
 * Returns array of { slug, displayName, imageUrl, category }.
 */
export async function getCandidateModels(parsedType, { topN = 8 } = {}) {
  const family = broadGarmentFamily(parsedType);
  const all = await loadModelImages();
  const candidates = [];
  for (const [slug, info] of Object.entries(all)) {
    const f = broadFamilyFromCategory(info.category);
    if (family && f && f === family) {
      candidates.push({ slug, ...info });
    }
  }
  // Sort by name for stability
  candidates.sort((a, b) => a.displayName.localeCompare(b.displayName));
  if (!family || candidates.length === 0) {
    // Fall back: send everything (capped). This will be expensive, so we cap small.
    const all2 = Object.entries(all).map(([slug, info]) => ({ slug, ...info }));
    return all2.slice(0, topN);
  }
  return candidates.slice(0, topN);
}

/**
 * Use dHash to find the visually-closest PIM products (with their model slugs),
 * then take the unique model slugs in confidence order. Useful as a primary
 * candidate set even when type detection failed.
 */
export async function getDhashCandidateModels(productImageUrl, { topN = 8 } = {}) {
  if (!productImageUrl) return [];
  const matches = await matchImage(productImageUrl, { topN: 50 });
  const seen = new Set();
  const all = await loadModelImages();
  const out = [];
  for (const m of matches) {
    if (seen.has(m.productSlug)) continue;
    const info = all[m.productSlug];
    if (!info) continue;
    seen.add(m.productSlug);
    out.push({
      slug: m.productSlug,
      displayName: info.displayName,
      imageUrl: info.imageUrl,
      category: info.category,
      dhashConfidence: m.confidence,
    });
    if (out.length >= topN) break;
  }
  return out;
}

/**
 * Build the final candidate list for vision, combining type-based filter and
 * dHash similarity. Type-matched + dHash-similar items rank highest.
 */
export async function buildCandidateModels(parsedType, productImageUrl, { topN = 8 } = {}) {
  const dhash = await getDhashCandidateModels(productImageUrl, { topN: 12 });
  const family = broadGarmentFamily(parsedType);
  const ranked = [];
  const seen = new Set();
  // First: dHash candidates that ALSO match the type family
  for (const c of dhash) {
    if (family && broadFamilyFromCategory(c.category) !== family) continue;
    if (seen.has(c.slug)) continue;
    seen.add(c.slug);
    ranked.push(c);
    if (ranked.length >= topN) return ranked;
  }
  // Then: any dHash candidates regardless of type
  for (const c of dhash) {
    if (seen.has(c.slug)) continue;
    seen.add(c.slug);
    ranked.push(c);
    if (ranked.length >= topN) return ranked;
  }
  // Then: any type-matched models (alphabetical) we haven't already included
  const typeOnly = await getCandidateModels(parsedType, { topN: 30 });
  for (const c of typeOnly) {
    if (seen.has(c.slug)) continue;
    seen.add(c.slug);
    ranked.push(c);
    if (ranked.length >= topN) return ranked;
  }
  return ranked;
}
