#!/usr/bin/env node
/**
 * Find the closest PIM-image match for a given Shopify product image.
 *
 * Usage:
 *   node scripts/match-product-image.mjs --url <https://...>     # remote image
 *   node scripts/match-product-image.mjs --file <path>           # local file
 *   node scripts/match-product-image.mjs --top 5                 # show top N (default 3)
 *   node scripts/match-product-image.mjs --index <path>          # custom index path
 *
 * Requires: npm install sharp
 *
 * Output: JSON to stdout
 *   { matches: [{ productSlug, colourSlug, file, distance, confidence }] }
 */
import fs from "node:fs/promises";
import process from "node:process";
import sharp from "sharp";

const args = process.argv.slice(2);
function arg(name, dflt) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : dflt;
}

const URL_ARG = arg("url");
const FILE_ARG = arg("file");
const TOP = Number.parseInt(arg("top", "3"), 10);
const INDEX_PATH = arg("index", "app/data/pimImageIndex.json");

if (!URL_ARG && !FILE_ARG) {
  console.error("Provide --url or --file");
  process.exit(2);
}

const HASH_W = 9;
const HASH_H = 8;

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

function hexToBigInt(hex) {
  return BigInt(`0x${hex}`);
}

function hammingDistance(a, b) {
  let xor = hexToBigInt(a) ^ hexToBigInt(b);
  let count = 0;
  while (xor !== 0n) {
    count += Number(xor & 1n);
    xor >>= 1n;
  }
  return count;
}

async function fetchBuffer(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} -> ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  return buf;
}

async function main() {
  const buffer = URL_ARG ? await fetchBuffer(URL_ARG) : await fs.readFile(FILE_ARG);
  const targetHash = await dHash(buffer);

  const idxRaw = await fs.readFile(INDEX_PATH, "utf8");
  const idx = JSON.parse(idxRaw);
  const totalBits = idx.hashBits ?? 64;

  const scored = idx.entries.map((e) => {
    const distance = hammingDistance(targetHash, e.h);
    const confidence = 1 - distance / totalBits;
    return {
      productSlug: e.p,
      colourSlug: e.c,
      file: e.f,
      distance,
      confidence: Number(confidence.toFixed(3)),
    };
  });

  scored.sort((a, b) => a.distance - b.distance);
  const matches = scored.slice(0, TOP);
  console.log(JSON.stringify({ targetHash, matches }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
