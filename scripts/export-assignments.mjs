#!/usr/bin/env node
/**
 * Export every assigned-colour metafield from a Shopify store as a portable JSON.
 *
 * The export is keyed by product handle (which is portable across stores), so
 * it can be re-applied on a different store with import-assignments.mjs.
 *
 * Usage:
 *   SHOP=your-shop.myshopify.com ACCESS_TOKEN=shpat_xxx \
 *   node scripts/export-assignments.mjs --out assignments.json
 *
 * The ACCESS_TOKEN must have read_products scope.
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
const OUT = arg("out", "assignments.json");

if (!SHOP || !TOKEN) {
  console.error("Set SHOP and ACCESS_TOKEN environment variables.");
  process.exit(1);
}

const QUERY = `#graphql
query ExportAssignments($cursor: String) {
  products(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        handle
        title
        assignedColour: metafield(namespace: "${NAMESPACE}", key: "${KEY}") { value }
      }
    }
  }
}`;

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

const assignments = {};
let cursor = null;
let page = 0;
do {
  page += 1;
  const data = await gql(QUERY, { cursor });
  const products = data.products;
  for (const { node } of products.edges) {
    if (node.assignedColour?.value) {
      assignments[node.handle] = {
        title: node.title,
        colour: node.assignedColour.value,
      };
    }
  }
  console.log(`page ${page}: ${products.edges.length} products scanned, ${Object.keys(assignments).length} assignments so far`);
  cursor = products.pageInfo.hasNextPage ? products.pageInfo.endCursor : null;
} while (cursor);

const out = {
  exportedAt: new Date().toISOString(),
  sourceShop: SHOP,
  count: Object.keys(assignments).length,
  assignments,
};
await fs.writeFile(OUT, JSON.stringify(out, null, 2));
console.log(`\nWrote ${out.count} assignments to ${OUT}`);
