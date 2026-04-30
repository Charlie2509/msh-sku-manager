#!/usr/bin/env node
/**
 * Build a perceptual-hash (dHash) index of every PIM product image.
 *
 * Usage:
 *   node scripts/index-pim-images.mjs [--images-dir <path>] [--out <path>]
 *
 * Defaults:
 *   --images-dir = C:\Users\Charlie\Desktop\New folder\macron_out\pim_images
 *   --out        = app/data/pimImageIndex.json
 *
 * Output JSON shape:
 *   {
 *     "version": 1,
 *     "hashBits": 64,
 *     "totalImages": 9131,
 *     "entries": [
 *       { "h": "1f8a23...", "p": "rigel-hero", "c": "white", "f": "rigel-hero/white/rigel-hero_white_1.jpg" }
 *     ]
 *   }
 *
 * Requires: npm install sharp
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";

// ---- args ----
const args = process.argv.slice(2);
function arg(name, dflt) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : dflt;
}

const IMAGES_DIR = arg(
  "images-dir",
  "C:\\Users\\Charlie\\Desktop\\New folder\\macron_out\\pim_images",
);
const OUT_PATH = arg("out", "app/data/pimImageIndex.json");
const HASH_W = 9;
const HASH_H = 8;

// ---- dHash ----
async function dHash(filePath) {
  const buf = await sharp(filePath)
    .greyscale()
    .resize(HASH_W, HASH_H, { fit: "fill" })
    .raw()
    .toBuffer();
  // buf has HASH_W * HASH_H bytes (one per pixel after greyscale)
  let bits = "";
  for (let y = 0; y < HASH_H; y += 1) {
    for (let x = 0; x < HASH_W - 1; x += 1) {
      const left = buf[y * HASH_W + x];
      const right = buf[y * HASH_W + x + 1];
      bits += left < right ? "1" : "0";
    }
  }
  // 64 bits -> hex
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

async function* walkJpegs(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    console.error(`Cannot read ${dir}: ${err.message}`);
    return;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walkJpegs(full);
    else if (/\.(jpe?g|png|webp)$/i.test(ent.name)) yield full;
  }
}

function relPathParts(absPath) {
  const rel = path.relative(IMAGES_DIR, absPath).replace(/\\/g, "/");
  const parts = rel.split("/");
  return {
    productSlug: parts[0] ?? "unknown",
    colourSlug: parts[1] ?? "unknown",
    relPath: rel,
  };
}

async function main() {
  console.log(`Indexing ${IMAGES_DIR} ...`);
  const start = Date.now();
  const entries = [];
  let scanned = 0;
  let failed = 0;

  for await (const file of walkJpegs(IMAGES_DIR)) {
    try {
      const h = await dHash(file);
      const { productSlug, colourSlug, relPath } = relPathParts(file);
      entries.push({ h, p: productSlug, c: colourSlug, f: relPath });
      scanned += 1;
      if (scanned % 250 === 0) {
        console.log(`  ${scanned} images hashed`);
      }
    } catch (err) {
      failed += 1;
      if (failed <= 5) console.warn(`  skipped ${file}: ${err.message}`);
    }
  }

  const out = {
    version: 1,
    hashBits: (HASH_W - 1) * HASH_H,
    totalImages: entries.length,
    builtAt: new Date().toISOString(),
    imagesDir: IMAGES_DIR,
    entries,
  };

  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(out));
  const took = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nDONE — ${entries.length} indexed (${failed} failed) in ${took}s`);
  console.log(`Wrote ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
