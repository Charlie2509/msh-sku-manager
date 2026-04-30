#!/usr/bin/env node
/**
 * Import an assignments.json (from export-assignments.mjs) into a different
 * Shopify store, matching by product handle.
 *
 * Usage:
 *   SHOP=your-LIVE-shop.myshopify.com ACCESS_TOKEN=shpat_xxx \
 *   node scripts/import-assignments.mjs --in assignments.json [--dry-run]
 *
 * The ACCESS_TOKEN must have write_metaobjects scope (and read_products to
 * resolve handles → product IDs).
 */
import fs from "node:fs/promises";
import process from "node:process";

const SHOP = process.env.SHOP;
const TOKEN = process.env.ACCESS_TOKEN;
const NAMESPACE = "msh";
const KEY = "assigned_colour";

const args = process.argv.slice(2);
function arg(name, dflt) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : dflt;
}
const IN = arg("in", "assignments.json");
const DRY = args.includes("--dry-run");

if (!SHOP || !TOKEN) {
  console.error("Set SHOP and ACCESS_TOKEN environment variables.");
  process.exit(1);
}

async function gql(query, variables = {}) {
  const r = await fetch(`https://${SHOP}/admin/api/2025-01/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!r.ok) throw new Error(`GraphQL ${r.status}: ${await r.text()}`);
  const json = await r.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function findProductIdByHandle(handle) {
  const data = await gql(
    `#graphql
    query Lookup($handle: String!) {
      productByHandle(handle: $handle) { id }
    }`,
    { handle },
  );
  return data.productByHandle?.id ?? null;
}

async function setMetafield(productId, value) {
  const data = await gql(
    `#graphql
    mutation SetMeta($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }`,
    {
      metafields: [
        {
          ownerId: productId,
          namespace: NAMESPACE,
          key: KEY,
          type: "single_line_text_field",
          value,
        },
      ],
    },
  );
  return data.metafieldsSet.userErrors;
}

const fileRaw = await fs.readFile(IN, "utf8");
const file = JSON.parse(fileRaw);
const entries = Object.entries(file.assignments);
console.log(`Importing ${entries.length} assignments to ${SHOP}${DRY ? " (DRY RUN)" : ""}`);

let saved = 0;
let notFound = 0;
let failed = 0;
for (const [handle, { colour }] of entries) {
  try {
    const productId = await findProductIdByHandle(handle);
    if (!productId) {
      console.log(`  ✗ no product on this store with handle '${handle}'`);
      notFound += 1;
      continue;
    }
    if (DRY) {
      console.log(`  → ${handle} → ${colour} (would set)`);
      saved += 1;
      continue;
    }
    const errs = await setMetafield(productId, colour);
    if (errs.length) {
      console.log(`  ✗ ${handle}: ${errs.map((e) => e.message).join("; ")}`);
      failed += 1;
    } else {
      console.log(`  ✓ ${handle} = ${colour}`);
      saved += 1;
    }
  } catch (err) {
    console.log(`  ✗ ${handle}: ${err.message}`);
    failed += 1;
  }
}

console.log(`\nDone: ${saved} saved, ${notFound} not found, ${failed} failed`);
