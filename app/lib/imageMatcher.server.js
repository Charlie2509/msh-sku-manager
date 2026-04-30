/**
 * Server-side image matcher.
 *
 * Loads the dHash index built by scripts/index-pim-images.mjs and provides
 * functions to find the closest PIM-image match for any given image URL.
 *
 * The index is loaded lazily and cached in module scope.
 */
import fs from "node:fs/promises";
import path from "node:path";

const HASH_W = 9;
const HASH_H = 8;
const TOTAL_BITS = (HASH_W - 1) * HASH_H; // 64
const INDEX_PATH = path.join(process.cwd(), "app", "data", "pimImageIndex.json");

let cachedIndex = null;
let cachedSharp = null;
let indexLoadError = null;

async function loadSharp() {
  if (cachedSharp) return cachedSharp;
  try {
    const mod = await import("sharp");
    cachedSharp = mod.default;
    return cachedSharp;
  } catch (err) {
    throw new Error("sharp is not installed. Run: npm install sharp");
  }
}

export async function getIndex() {
  if (cachedIndex) return cachedIndex;
  if (indexLoadError) return null;
  try {
    const raw = await fs.readFile(INDEX_PATH, "utf8");
    cachedIndex = JSON.parse(raw);
    return cachedIndex;
  } catch (err) {
    indexLoadError = err;
    return null;
  }
}

async function dHash(buffer) {
  const sharp = await loadSharp();
  const raw = await sharp(buffer)
    .greyscale()
    .resize(HASH_W, HASH_H, { fit: "fill" })
    .raw()
    .toBuffer();
  let bits = "";
  for (let y = 0; y < HASH_H; y += 1) {
    for (let x = 0; x < HASH_W - 1; x += 1) {
      bits += raw[y * HASH_W + x] < raw[y * HASH_W + x + 1] ? "1" : "0";
    }
  }
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

function hammingDistance(a, b) {
  let xor = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (xor !== 0n) {
    count += Number(xor & 1n);
    xor >>= 1n;
  }
  return count;
}

/**
 * Returns the top-N nearest PIM matches for an image URL.
 * Returns [] if image fetch fails OR the index hasn't been built yet.
 */
export async function matchImage(imageUrl, { topN = 5 } = {}) {
  if (!imageUrl) return [];
  const idx = await getIndex();
  if (!idx) return [];

  let buf;
  try {
    const r = await fetch(imageUrl);
    if (!r.ok) return [];
    buf = Buffer.from(await r.arrayBuffer());
  } catch {
    return [];
  }

  let targetHash;
  try {
    targetHash = await dHash(buf);
  } catch {
    return [];
  }

  const scored = idx.entries.map((e) => ({
    productSlug: e.p,
    colourSlug: e.c,
    file: e.f,
    distance: hammingDistance(targetHash, e.h),
  }));
  scored.sort((a, b) => a.distance - b.distance);
  return scored.slice(0, topN).map((m) => ({
    ...m,
    confidence: Number((1 - m.distance / TOTAL_BITS).toFixed(3)),
  }));
}

/**
 * Cleans the raw colour slug from PIM (which can be multi-tone like "black-black"
 * or "neon-green-green") into a normalised colour string.
 * Then maps it to one of the model's allowedColours if possible.
 */
function resolveColourFromSlug(colourSlug, allowedColours) {
  if (!colourSlug) return { colour: null, validatedAgainstAllowed: false };
  // Split, dedupe consecutive identical words ("black-black" -> "black")
  const parts = colourSlug.split("-").filter(Boolean);
  const deduped = [];
  for (const p of parts) {
    if (deduped[deduped.length - 1] !== p) deduped.push(p);
  }
  // Final dedupe — remove any remaining duplicate tokens
  const uniqueParts = [...new Set(deduped)];
  const cleanedSlug = uniqueParts.join("-");

  if (allowedColours?.length) {
    const allowedSlugs = allowedColours.map((c) => ({
      raw: c,
      slug: c.toLowerCase().replace(/\s+/g, "-"),
    }));
    // 1) Exact slug match (cleaned)
    let hit = allowedSlugs.find((a) => a.slug === cleanedSlug);
    if (hit) return { colour: hit.raw, validatedAgainstAllowed: true };
    // 2) Allowed colour fully contained in cleanedSlug
    hit = allowedSlugs
      .sort((a, b) => b.slug.length - a.slug.length) // prefer longer/more specific matches
      .find((a) => cleanedSlug.split("-").join("-").includes(a.slug));
    if (hit) return { colour: hit.raw, validatedAgainstAllowed: true };
    // 3) Any cleanedSlug part matches an allowed colour
    for (const part of uniqueParts) {
      hit = allowedSlugs.find((a) => a.slug === part);
      if (hit) return { colour: hit.raw, validatedAgainstAllowed: true };
    }
  }

  // No allowedColour match — return the cleaned slug, capitalised, but mark unvalidated
  const display = cleanedSlug
    .split("-")
    .filter(Boolean)
    .map((w) => w.toUpperCase())
    .join(" ");
  return { colour: display, validatedAgainstAllowed: false };
}

/**
 * Same as matchImage but biases results to the model we already know
 * (from the parsed product title), and returns the most likely COLOUR
 * that's in the allowedColours list.
 */
export async function suggestColourFromImage(imageUrl, expectedProductSlug, allowedColours) {
  const matches = await matchImage(imageUrl, { topN: 50 });
  if (matches.length === 0) return null;

  // 1) Within matches whose productSlug == expectedProductSlug, pick the closest
  if (expectedProductSlug) {
    const sameProduct = matches.filter((m) => m.productSlug === expectedProductSlug);
    if (sameProduct.length > 0) {
      const top = sameProduct[0];
      const { colour, validatedAgainstAllowed } = resolveColourFromSlug(top.colourSlug, allowedColours);
      return {
        colour,
        validatedAgainstAllowed,
        productSlugMatched: top.productSlug,
        distance: top.distance,
        confidence: top.confidence,
        scopedToExpectedProduct: true,
      };
    }
  }

  // 2) Otherwise just take the absolute closest match
  const top = matches[0];
  const { colour, validatedAgainstAllowed } = resolveColourFromSlug(top.colourSlug, allowedColours);
  return {
    colour,
    validatedAgainstAllowed,
    productSlugMatched: top.productSlug,
    distance: top.distance,
    confidence: top.confidence,
    scopedToExpectedProduct: false,
  };
}
