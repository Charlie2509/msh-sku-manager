/**
 * Visual-parse endpoint.
 *
 * POST { imageUrl }  →  { matches: [{ productSlug, colourSlug, distance, confidence }] }
 *
 * Loads the perceptual-hash index built by scripts/index-pim-images.mjs,
 * fetches the supplied image, hashes it, and returns the top-5 closest PIM
 * matches by Hamming distance.
 */
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { authenticate } from "../shopify.server";

const INDEX_PATH = path.join(process.cwd(), "app", "data", "pimImageIndex.json");
const HASH_W = 9;
const HASH_H = 8;

let cachedIndex = null;
async function loadIndex() {
  if (cachedIndex) return cachedIndex;
  const raw = await fs.readFile(INDEX_PATH, "utf8");
  cachedIndex = JSON.parse(raw);
  return cachedIndex;
}

async function dHash(buffer) {
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

export const action = async ({ request }) => {
  await authenticate.admin(request);

  let imageUrl;
  if (request.headers.get("content-type")?.includes("application/json")) {
    const body = await request.json();
    imageUrl = body.imageUrl;
  } else {
    const fd = await request.formData();
    imageUrl = fd.get("imageUrl");
  }

  if (!imageUrl) {
    return new Response(JSON.stringify({ error: "Missing imageUrl" }), { status: 400 });
  }

  let index;
  try {
    index = await loadIndex();
  } catch (err) {
    return new Response(
      JSON.stringify({
        error:
          "Image index not built yet. Run: node scripts/index-pim-images.mjs",
      }),
      { status: 500 },
    );
  }

  const r = await fetch(imageUrl);
  if (!r.ok) {
    return new Response(JSON.stringify({ error: `Image fetch ${r.status}` }), { status: 502 });
  }
  const buf = Buffer.from(await r.arrayBuffer());
  const targetHash = await dHash(buf);

  const totalBits = index.hashBits ?? 64;
  const scored = index.entries.map((e) => ({
    productSlug: e.p,
    colourSlug: e.c,
    file: e.f,
    distance: hammingDistance(targetHash, e.h),
  }));
  scored.sort((a, b) => a.distance - b.distance);
  const matches = scored.slice(0, 5).map((m) => ({
    ...m,
    confidence: Number((1 - m.distance / totalBits).toFixed(3)),
  }));

  return new Response(JSON.stringify({ targetHash, matches }), {
    headers: { "Content-Type": "application/json" },
  });
};
