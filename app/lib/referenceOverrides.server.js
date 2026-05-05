/**
 * User-editable Macron model overrides.
 *
 * Stored in a JSON file on disk so the user can add/edit/remove models without
 * touching the auto-generated macronReference.js. When the brochures update
 * each year, new products are added through the in-app editor instead of
 * regenerating the static reference.
 *
 * Shape of the file:
 *   {
 *     "rigel-hero": {
 *       "displayName": "Rigel Hero",
 *       "garmentType": "t-shirt",
 *       "allowedColours": ["WHITE", "NAVY", ...],
 *       "aliases": []
 *     },
 *     ...
 *   }
 *
 * Override entries take PRECEDENCE over the static reference for the same slug.
 * To "delete" a model, set it to null in the file (or remove via the UI).
 */
import fs from "node:fs/promises";
import path from "node:path";

const OVERRIDES_PATH = path.join(process.cwd(), "app", "data", "macronReferenceOverrides.json");

let cached = null;
async function load() {
  if (cached) return cached;
  try {
    cached = JSON.parse(await fs.readFile(OVERRIDES_PATH, "utf8"));
  } catch {
    cached = {};
  }
  return cached;
}

async function save() {
  if (!cached) return;
  await fs.mkdir(path.dirname(OVERRIDES_PATH), { recursive: true });
  await fs.writeFile(OVERRIDES_PATH, JSON.stringify(cached, null, 2));
}

function slugify(s) {
  return (s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export async function listOverrides() {
  return await load();
}

export async function upsertOverride({ slug, displayName, garmentType, allowedColours, aliases }) {
  await load();
  const cleanSlug = slugify(slug || displayName);
  if (!cleanSlug) return { ok: false, error: "Empty slug/displayName" };
  cached[cleanSlug] = {
    slug: cleanSlug,
    displayName: (displayName || cleanSlug).trim(),
    garmentType: (garmentType || "unknown").trim().toLowerCase(),
    allowedColours: Array.isArray(allowedColours)
      ? allowedColours.map((c) => c.trim().toUpperCase()).filter(Boolean)
      : [],
    aliases: Array.isArray(aliases) ? aliases.map((a) => a.trim().toLowerCase()).filter(Boolean) : [],
    source: "user-override",
  };
  await save();
  return { ok: true, slug: cleanSlug, entry: cached[cleanSlug] };
}

export async function deleteOverride(slug) {
  await load();
  const cleanSlug = slugify(slug);
  if (!cleanSlug || !(cleanSlug in cached)) return { ok: false, error: "Not found" };
  delete cached[cleanSlug];
  await save();
  return { ok: true };
}

/**
 * Returns a Map of slug -> reference entry that includes BOTH the static
 * macronReference AND the user overrides (with overrides winning on conflict).
 * Pass in the static map (already loaded as a JS object).
 */
export async function mergedReferenceMap(staticMap) {
  const overrides = await load();
  const merged = { ...(staticMap || {}) };
  for (const [slug, entry] of Object.entries(overrides)) {
    if (!entry) {
      delete merged[slug];
      continue;
    }
    merged[slug] = entry;
    // Also index aliases
    for (const alias of entry.aliases || []) {
      merged[alias.toLowerCase()] = entry;
    }
    // First-word fallback
    const firstWord = entry.displayName.toLowerCase().split(/\s+/)[0];
    if (firstWord && !merged[firstWord]) merged[firstWord] = entry;
  }
  return merged;
}
