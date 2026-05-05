import { useEffect, useMemo, useState } from "react";
import { Form, useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import { suggestColourFromImage } from "../lib/imageMatcher.server";
import { isVisionLlmEnabled, classifyColourWithVision, classifyModelWithVision } from "../lib/visionLlm.server";
import { buildCandidateModels } from "../lib/modelMatcher.server";
import { ASSIGNED_COLOUR_NAMESPACE, ASSIGNED_COLOUR_KEY, ASSIGNED_MODEL_KEY } from "../lib/assignedColour.constants";
import { writeAssignedColour, writeAssignedModel } from "../lib/assignedColour.server";
import { detectColour, detectColourFromVariant, detectSizeFromVariant, formatSizeLabel, getAllowedColoursMessage, normalizeColourDisplay, parseProductTitle } from "../lib/skuParser";
import { macronModelReferences, macronReferenceMap } from "../data/macronReference";
import { generateVariantSku } from "../lib/skuGenerator";

// dHash distance threshold (out of 64 bits). Below this we trust the suggestion enough
// to display it boldly; above, we mark it low-confidence.
const STRONG_MATCH_DISTANCE = 12;
const DUPLICATE_SKU_WARNING = "Duplicate generated SKUs detected — do not auto-write until variants are cleaned.";

function getProductPresentation(product) {
  const titleParsed = parseProductTitle(product.title, product.handle);

  // If a model has been manually assigned via metafield AND the title parser
  // didn't already find one, use the assignment to look up the reference and
  // overlay it onto the parse result. This unblocks "review" products that
  // genuinely don't have a Macron model name in the title.
  let parsed = titleParsed;
  let modelSource = titleParsed.model ? "title" : null;
  if (!titleParsed.model && product.assignedModel) {
    const ref = macronReferenceMap[product.assignedModel.toLowerCase()];
    if (ref) {
      parsed = {
        ...titleParsed,
        model: ref.displayName,
        modelReference: ref,
        allowedColours: ref.allowedColours ?? null,
      };
      modelSource = "assigned";
    }
  }

  const normalizedAssignedColour = normalizeColourDisplay(product.assignedColour);
  const variantColours = (product.variants?.edges ?? [])
    .map(({ node }) => detectColourFromVariant(node, parsed.allowedColours))
    .filter(Boolean);
  const effectiveColour = parsed.colour ?? variantColours[0] ?? normalizedAssignedColour ?? null;
  const colourSource = parsed.colour ? "title" : variantColours.length ? "variant" : normalizedAssignedColour ? "assigned" : null;
  const hasColorOption = (product.options ?? []).some((o) =>
    ["color", "colour"].includes((o.name || "").toLowerCase()),
  );

  let effectiveStatus = parsed.status;
  let effectiveReason = parsed.partialReason;
  if (parsed.model && parsed.type && effectiveColour) {
    effectiveStatus = "matched";
    effectiveReason = null;
  } else if (parsed.model && parsed.type && !effectiveColour && !hasColorOption) {
    effectiveStatus = "needs-colour";
    effectiveReason = "single-colour product, assign colour manually";
  } else if (!parsed.model) {
    effectiveStatus = "review";
    effectiveReason = "missing model — assign one below or rename product in Shopify";
  }

  const variantRows = [];
  const counts = new Map();
  for (const { node: variant } of (product.variants?.edges ?? [])) {
    const variantColour = detectColourFromVariant(variant, parsed.allowedColours);
    const variantSize = detectSizeFromVariant(variant);
    const finalColour = variantColour ?? effectiveColour;
    const generatedSku = generateVariantSku({ model: parsed.model, colour: finalColour, size: variantSize });
    counts.set(generatedSku, (counts.get(generatedSku) ?? 0) + 1);
    variantRows.push({
      id: variant.id,
      inventoryItemId: variant.inventoryItem?.id ?? null,
      inventoryItemSku: variant.inventoryItem?.sku ?? "",
      variantColour,
      variantSize,
      generatedSku,
      existingSku: variant.sku ?? "",
    });
  }
  const hasDuplicateGeneratedSkus = [...counts.values()].some((n) => n > 1);
  const hasNaGeneratedSku = variantRows.some((row) => row.generatedSku?.toLowerCase().includes("na"));
  const hasEmptyGeneratedSku = variantRows.some((row) => !row.generatedSku?.trim());
  // Writable subset: keep first occurrence of each generated SKU. Subsequent
  // duplicates are flagged so the user can clean them up in Shopify, but the
  // first variants still get their SKUs written.
  const seenSkus = new Set();
  const writableVariantRows = variantRows.filter((row) => {
    if (!row.generatedSku?.trim()) return false;
    if (row.generatedSku.toLowerCase().includes("na")) return false;
    if (seenSkus.has(row.generatedSku)) return false;
    seenSkus.add(row.generatedSku);
    return true;
  });
  const isSafeForSkuWrite = (
    effectiveStatus === "matched"
    && Boolean(parsed.model)
    && Boolean(effectiveColour)
    && !hasDuplicateGeneratedSkus
    && !hasNaGeneratedSku
    && !hasEmptyGeneratedSku
  );
  // Looser gate used by the bulk writer: allow products with duplicate variants
  // through, but only write to the first occurrence of each SKU.
  const isWriteable = (
    effectiveStatus === "matched"
    && Boolean(parsed.model)
    && Boolean(effectiveColour)
    && writableVariantRows.length > 0
  );
  return {
    parsed,
    modelSource,
    normalizedAssignedColour,
    effectiveColour,
    colourSource,
    hasColorOption,
    effectiveStatus,
    effectiveReason,
    variantRows,
    writableVariantRows,
    hasDuplicateGeneratedSkus,
    isSafeForSkuWrite,
    isWriteable,
  };
}

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  // Cursor-paginate the dashboard view across the entire catalogue.
  // We deliberately fetch ALL products so bulk actions, stats, and tabs
  // reflect the real state of the store (not just the first page).
  const QUERY = `#graphql
    query DashboardProducts($cursor: String) {
      products(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            title
            handle
            featuredImage { url altText }
            options { name values }
            assignedColour: metafield(namespace: "${ASSIGNED_COLOUR_NAMESPACE}", key: "${ASSIGNED_COLOUR_KEY}") { value }
            assignedModel:  metafield(namespace: "${ASSIGNED_COLOUR_NAMESPACE}", key: "${ASSIGNED_MODEL_KEY}")  { value }
            variants(first: 50) {
              edges {
                node {
                  id
                  title
                  sku
                  selectedOptions { name value }
                }
              }
            }
          }
        }
      }
    }`;

  // Dashboard view: ONE PAGE only (100 products). The bulk action buttons
  // operate over the entire catalogue independently, so the dashboard
  // doesn't need to render thousands of cards (which would crash the browser
  // and time out Cloudflare).
  const url = new URL(request.url);
  const pageCursor = url.searchParams.get("cursor") || null;
  const products = [];
  let nextCursor = null;
  let hasMore = false;
  const r = await admin.graphql(QUERY, { variables: { cursor: pageCursor } });
  const j = await r.json();
  const pp = j?.data?.products;
  if (pp) {
    for (const { node } of pp.edges) {
      products.push({
        ...node,
        assignedColour: node.assignedColour?.value ?? null,
        assignedModel: node.assignedModel?.value ?? null,
      });
    }
    hasMore = Boolean(pp.pageInfo?.hasNextPage);
    nextCursor = pp.pageInfo?.endCursor ?? null;
  }

  // dHash auto-suggestions in the loader are only useful when the user is
  // actively reviewing individual cards. For a multi-hundred catalogue we
  // skip them on render (each is a network image fetch) and rely on the
  // explicit "Auto-assign confident matches" button to do the bulk work.
  // Cap at first SUGGESTION_LIMIT eligible products so small dev stores still
  // see suggestions on first load.
  const SUGGESTION_LIMIT = 30;
  const eligible = products.filter((p) => {
    if (p.assignedColour) return false;
    const parsed = parseProductTitle(p.title, p.handle);
    if (!parsed.model || !parsed.allowedColours?.length) return false;
    const hasColorOption = (p.options ?? []).some((o) =>
      ["color", "colour"].includes((o.name || "").toLowerCase()),
    );
    const titleColour = detectColour(p.title.split(/\s+/), p.handle);
    return !titleColour && !hasColorOption && Boolean(p.featuredImage?.url);
  }).slice(0, SUGGESTION_LIMIT);

  await Promise.all(
    eligible.map(async (p) => {
      const parsed = parseProductTitle(p.title, p.handle);
      const suggestion = await suggestColourFromImage(
        p.featuredImage.url,
        parsed.modelReference?.slug ?? null,
        parsed.allowedColours,
      );
      if (suggestion) {
        p.suggestion = suggestion;
        p.suggestion.isStrong = suggestion.distance <= STRONG_MATCH_DISTANCE;
      }
    }),
  );

  return { products, pagination: { hasMore, nextCursor, currentCursor: pageCursor } };
};

/**
 * Helper: re-fetch every product (id, title, handle, image, allowed colours,
 * existing assigned colour) so a bulk action can iterate over them.
 */
/**
 * Fetch ONE page of products from Shopify (default 100). Returns the products
 * and the cursor for the next page. Each batched bulk action calls this once
 * per request, instead of fetching the entire catalogue every batch (which
 * Shopify rate-limits).
 */
/**
 * Quick count of total products in the store. Used for progress percentages.
 * One cheap GraphQL call.
 */
async function fetchProductsCount(admin) {
  try {
    const r = await admin.graphql(`#graphql
      query ProductsCount { productsCount { count } }`);
    const j = await r.json();
    return j?.data?.productsCount?.count ?? null;
  } catch {
    return null;
  }
}

async function fetchOnePageForBulk(admin, cursor = null, pageSize = 100) {
  const QUERY = `#graphql
    query OnePage($cursor: String, $pageSize: Int!) {
      products(first: $pageSize, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            title
            handle
            featuredImage { url }
            options { name }
            assignedColour: metafield(namespace: "${ASSIGNED_COLOUR_NAMESPACE}", key: "${ASSIGNED_COLOUR_KEY}") { value }
            assignedModel:  metafield(namespace: "${ASSIGNED_COLOUR_NAMESPACE}", key: "${ASSIGNED_MODEL_KEY}")  { value }
            variants(first: 50) {
              edges {
                node {
                  id
                  title
                  sku
                  selectedOptions { name value }
                  inventoryItem { id sku }
                }
              }
            }
          }
        }
      }
    }`;
  const r = await admin.graphql(QUERY, { variables: { cursor, pageSize } });
  const j = await r.json();
  const pp = j?.data?.products;
  if (!pp) return { products: [], hasNextPage: false, endCursor: null };
  return {
    products: pp.edges.map(({ node }) => ({
      ...node,
      assignedColour: node.assignedColour?.value ?? null,
      assignedModel: node.assignedModel?.value ?? null,
    })),
    hasNextPage: Boolean(pp.pageInfo?.hasNextPage),
    endCursor: pp.pageInfo?.endCursor ?? null,
  };
}

async function fetchAllProductsForBulk(admin) {
  // Cursor-paginate the full catalogue. Stops at hasNextPage=false.
  const QUERY = `#graphql
    query AllProducts($cursor: String) {
      products(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            title
            handle
            featuredImage { url }
            options { name }
            assignedColour: metafield(namespace: "${ASSIGNED_COLOUR_NAMESPACE}", key: "${ASSIGNED_COLOUR_KEY}") { value }
            assignedModel:  metafield(namespace: "${ASSIGNED_COLOUR_NAMESPACE}", key: "${ASSIGNED_MODEL_KEY}")  { value }
            variants(first: 50) {
              edges {
                node {
                  id
                  title
                  sku
                  selectedOptions { name value }
                  inventoryItem { id sku }
                }
              }
            }
          }
        }
      }
    }`;
  const out = [];
  let cursor = null;
  // Hard cap at 50 pages (5,000 products) as a runaway guard.
  for (let page = 0; page < 50; page += 1) {
    const r = await admin.graphql(QUERY, { variables: { cursor } });
    const json = await r.json();
    const products = json?.data?.products;
    if (!products) break;
    for (const { node } of products.edges) {
      out.push({
        ...node,
        assignedColour: node.assignedColour?.value ?? null,
        assignedModel: node.assignedModel?.value ?? null,
      });
    }
    if (!products.pageInfo?.hasNextPage) break;
    cursor = products.pageInfo.endCursor;
  }
  return out;
}


// Each batched action processes at most this many eligible products per request.
// Cloudflare drops connections after ~100s — keep batches well inside that.
const BATCH_SIZE_FAST = 25;   // dHash-only (fast, ~1s each)
const BATCH_SIZE_SLOW = 12;   // OpenAI (~3-5s each)

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const bulk = formData.get("bulk")?.toString();
  // Each batch processes one Shopify page (~100 products). The `cursor` field
  // is the Shopify endCursor returned by the previous batch; null = first page.
  const inCursor = formData.get("cursor")?.toString() || null;
  const pageNumber = Number.parseInt(formData.get("pageNumber") ?? "0", 10) || 0;
  const cumulativeScannedIn = Number.parseInt(formData.get("cumulativeScanned") ?? "0", 10) || 0;
  const cumulativeSavedIn = Number.parseInt(formData.get("cumulativeSaved") ?? "0", 10) || 0;
  const cumulativeUnknownIn = Number.parseInt(formData.get("cumulativeUnknown") ?? "0", 10) || 0;
  const cumulativeUpdatedIn = Number.parseInt(formData.get("cumulativeUpdated") ?? "0", 10) || 0;
  const cumulativeMergedIn = Number.parseInt(formData.get("cumulativeMerged") ?? "0", 10) || 0;
  const cumulativeFailedIn = Number.parseInt(formData.get("cumulativeFailed") ?? "0", 10) || 0;
  // Get total once at start of chain so % progress is meaningful
  const totalIn = Number.parseInt(formData.get("totalProducts") ?? "0", 10) || 0;
  const totalProducts = totalIn > 0 ? totalIn : await fetchProductsCount(admin);

  // ─── BULK: auto-assign all confident dHash matches ────────────────────────
  if (bulk === "autoAssignConfident") {
    const { products, hasNextPage, endCursor } = await fetchOnePageForBulk(admin, inCursor);
    const eligible = products.filter((p) => {
      if (p.assignedColour) return false;
      const parsed = parseProductTitle(p.title, p.handle);
      if (!parsed.model || !parsed.allowedColours?.length) return false;
      const hasColorOption = (p.options ?? []).some((o) =>
        ["color", "colour"].includes((o.name || "").toLowerCase()),
      );
      const titleColour = detectColour(p.title.split(/\s+/), p.handle);
      if (titleColour || hasColorOption) return false;
      return Boolean(p.featuredImage?.url);
    });
    let saved = 0;
    let skipped = 0;
    await Promise.all(
      eligible.map(async (p) => {
        const parsed = parseProductTitle(p.title, p.handle);
        const suggestion = await suggestColourFromImage(
          p.featuredImage.url,
          parsed.modelReference?.slug ?? null,
          parsed.allowedColours,
        );
        if (
          suggestion?.validatedAgainstAllowed &&
          suggestion.distance <= STRONG_MATCH_DISTANCE &&
          suggestion.scopedToExpectedProduct
        ) {
          const r = await writeAssignedColour(admin, p.id, suggestion.colour);
          if (r.ok) saved += 1;
        } else {
          skipped += 1;
        }
      }),
    );
    return {
      ok: true,
      bulk,
      saved,
      skipped,
      processedThisBatch: eligible.length,
      pageProductsScanned: products.length,
      totalProducts,
      cumulativeScanned: cumulativeScannedIn + products.length,
      cumulativeSaved: cumulativeSavedIn + (typeof saved !== 'undefined' ? saved : 0),
      cumulativeUnknown: cumulativeUnknownIn + (typeof unknown !== 'undefined' ? unknown : 0),
      cumulativeUpdated: cumulativeUpdatedIn + (typeof updated !== 'undefined' ? updated : 0),
      cumulativeMerged: cumulativeMergedIn + (typeof merged !== 'undefined' ? merged : 0),
      cumulativeFailed: cumulativeFailedIn + (typeof failed !== 'undefined' ? failed : 0),
      nextCursor: endCursor,
      pageNumber: pageNumber + 1,
      hasMore: hasNextPage,
    };
  }

  // ─── BULK: vision-LLM second-stage pass for low-confidence items ──────────
  if (bulk === "visionPass") {
    if (!isVisionLlmEnabled()) {
      return { ok: false, error: "OPENAI_API_KEY not set in environment" };
    }
    // Use a smaller page so OpenAI calls fit inside Cloudflare's window.
    const { products, hasNextPage, endCursor } = await fetchOnePageForBulk(admin, inCursor, 25);
    const eligible = products.filter((p) => {
      if (p.assignedColour) return false;
      const parsed = parseProductTitle(p.title, p.handle);
      return parsed.model && parsed.allowedColours?.length && p.featuredImage?.url;
    });
    let saved = 0;
    let unknown = 0;
    for (const p of eligible) {
      const parsed = parseProductTitle(p.title, p.handle);
      const llmColour = await classifyColourWithVision(
        p.featuredImage.url,
        parsed.allowedColours,
        parsed.model,
      );
      if (llmColour) {
        const r = await writeAssignedColour(admin, p.id, llmColour);
        if (r.ok) saved += 1;
      } else {
        unknown += 1;
      }
    }
    return {
      ok: true,
      bulk,
      saved,
      unknown,
      processedThisBatch: eligible.length,
      pageProductsScanned: products.length,
      totalProducts,
      cumulativeScanned: cumulativeScannedIn + products.length,
      cumulativeSaved: cumulativeSavedIn + (typeof saved !== 'undefined' ? saved : 0),
      cumulativeUnknown: cumulativeUnknownIn + (typeof unknown !== 'undefined' ? unknown : 0),
      cumulativeUpdated: cumulativeUpdatedIn + (typeof updated !== 'undefined' ? updated : 0),
      cumulativeMerged: cumulativeMergedIn + (typeof merged !== 'undefined' ? merged : 0),
      cumulativeFailed: cumulativeFailedIn + (typeof failed !== 'undefined' ? failed : 0),
      nextCursor: endCursor,
      pageNumber: pageNumber + 1,
      hasMore: hasNextPage,
    };
  }

  // ─── BULK: vision-LLM second-stage pass for MODEL identification ──────────
  // Targets products where the parser found no Macron model (review status).
  // Uses dHash + type-aware filtering to assemble a small candidate set, then
  // OpenAI vision picks the right base model from the candidates.
  if (bulk === "visionPassModels") {
    if (!isVisionLlmEnabled()) {
      return { ok: false, error: "OPENAI_API_KEY not set in environment" };
    }
    // Multi-image vision is slowest — fetch a small page (15 products).
    const { products, hasNextPage, endCursor } = await fetchOnePageForBulk(admin, inCursor, 15);
    const eligible = products.filter((p) => {
      if (p.assignedModel) return false;
      const parsed = parseProductTitle(p.title, p.handle);
      return !parsed.model && Boolean(p.featuredImage?.url);
    });
    let saved = 0;
    let unknown = 0;
    for (const p of eligible) {
      const parsed = parseProductTitle(p.title, p.handle);
      const candidates = await buildCandidateModels(parsed.type, p.featuredImage.url, { topN: 8 });
      if (!candidates.length) { unknown += 1; continue; }
      const chosen = await classifyModelWithVision(p.featuredImage.url, candidates, parsed.type);
      if (chosen?.displayName) {
        const r = await writeAssignedModel(admin, p.id, chosen.displayName);
        if (r.ok) saved += 1;
      } else {
        unknown += 1;
      }
    }
    return {
      ok: true,
      bulk,
      saved,
      unknown,
      processedThisBatch: eligible.length,
      pageProductsScanned: products.length,
      totalProducts,
      cumulativeScanned: cumulativeScannedIn + products.length,
      cumulativeSaved: cumulativeSavedIn + (typeof saved !== 'undefined' ? saved : 0),
      cumulativeUnknown: cumulativeUnknownIn + (typeof unknown !== 'undefined' ? unknown : 0),
      cumulativeUpdated: cumulativeUpdatedIn + (typeof updated !== 'undefined' ? updated : 0),
      cumulativeMerged: cumulativeMergedIn + (typeof merged !== 'undefined' ? merged : 0),
      cumulativeFailed: cumulativeFailedIn + (typeof failed !== 'undefined' ? failed : 0),
      nextCursor: endCursor,
      pageNumber: pageNumber + 1,
      hasMore: hasNextPage,
    };
  }

  if (bulk === "writeSafeSkus") {
    const { products, hasNextPage, endCursor } = await fetchOnePageForBulk(admin, inCursor);
    const eligible = products.filter((product) => getProductPresentation(product).isWriteable);
    let updated = 0;
    let skipped = 0;
    let failed = 0;
    let failedProducts = 0;
    const userErrorMessages = [];

    for (const product of eligible) {
      const presentation = getProductPresentation(product);
      if (!presentation.isWriteable) continue;

      const variants = presentation.writableVariantRows
        .filter((row) => row.existingSku !== row.generatedSku)
        .map((row) => ({
          id: row.id,
          inventoryItem: { sku: row.generatedSku },
        }));

      // Anything in variantRows but not writableVariantRows is a duplicate we skipped
      const duplicatesSkipped = presentation.variantRows.length - presentation.writableVariantRows.length;
      const unchangedCount = presentation.writableVariantRows.length - variants.length;
      skipped += unchangedCount + duplicatesSkipped;

      if (!variants.length) {
        continue;
      }

      try {
        const resp = await admin.graphql(
          `#graphql
          mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
            productVariantsBulkUpdate(productId: $productId, variants: $variants) {
              product {
                id
              }
              productVariants {
                id
                sku
                inventoryItem {
                  id
                  sku
                }
              }
              userErrors {
                field
                message
              }
            }
          }
          `,
          {
            variables: {
              productId: product.id,
              variants,
            },
          },
        );

        const json = await resp.json();

        if (json?.errors?.length) {
          failedProducts += 1;
          failed += variants.length;
          userErrorMessages.push(
            ...json.errors.slice(0, 3).map((e) => `${product.title}: ${e.message}`),
          );
          continue;
        }

        const result = json?.data?.productVariantsBulkUpdate;
        const errors = result?.userErrors ?? [];

        if (errors.length) {
          failedProducts += 1;
          failed += variants.length;
          userErrorMessages.push(
            ...errors.slice(0, 3).map((e) => `${product.title}: ${e.message}`),
          );
          continue;
        }

        updated += result?.productVariants?.length ?? variants.length;
      } catch (error) {
        failedProducts += 1;
        failed += variants.length;
        userErrorMessages.push(`${product.title}: ${error?.message ?? "Unknown GraphQL error"}`);
      }
    }

    return {
      ok: true,
      bulk,
      updated,
      skipped,
      failed,
      failedProducts,
      userErrors: userErrorMessages.slice(0, 5),
      processedThisBatch: eligible.length,
      pageProductsScanned: products.length,
      totalProducts,
      cumulativeScanned: cumulativeScannedIn + products.length,
      cumulativeSaved: cumulativeSavedIn + (typeof saved !== 'undefined' ? saved : 0),
      cumulativeUnknown: cumulativeUnknownIn + (typeof unknown !== 'undefined' ? unknown : 0),
      cumulativeUpdated: cumulativeUpdatedIn + (typeof updated !== 'undefined' ? updated : 0),
      cumulativeMerged: cumulativeMergedIn + (typeof merged !== 'undefined' ? merged : 0),
      cumulativeFailed: cumulativeFailedIn + (typeof failed !== 'undefined' ? failed : 0),
      nextCursor: endCursor,
      pageNumber: pageNumber + 1,
      hasMore: hasNextPage,
    };
  }

  // ─── BULK: clean up duplicate variants per product ────────────────────────
  // Variants like "S" and "Small" produce the same generated SKU. Keep the
  // first variant per SKU, delete the duplicates. Inventory is moved by
  // Shopify automatically (orders that reference the deleted variant become
  // historical records).
  if (bulk === "mergeDuplicateVariants") {
    const { products, hasNextPage, endCursor } = await fetchOnePageForBulk(admin, inCursor);
    const productsWithDupes = products.filter((product) =>
      getProductPresentation(product).hasDuplicateGeneratedSkus,
    );
    let merged = 0;
    let failed = 0;
    const userErrorMessages = [];
    for (const product of productsWithDupes) {
      const presentation = getProductPresentation(product);
      if (!presentation.hasDuplicateGeneratedSkus) continue;
      // The keepers are presentation.writableVariantRows; everything else in
      // variantRows with a matching generated SKU is a duplicate to delete.
      const keepIds = new Set(presentation.writableVariantRows.map((r) => r.id));
      const toDelete = presentation.variantRows
        .filter((r) => !keepIds.has(r.id))
        .map((r) => r.id);
      if (!toDelete.length) continue;
      try {
        const resp = await admin.graphql(
          `#graphql
          mutation productVariantsBulkDelete($productId: ID!, $variantsIds: [ID!]!) {
            productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) {
              userErrors { field message }
            }
          }`,
          { variables: { productId: product.id, variantsIds: toDelete } },
        );
        const json = await resp.json();
        const errs = json?.data?.productVariantsBulkDelete?.userErrors ?? [];
        if (errs.length) {
          failed += 1;
          userErrorMessages.push(`${product.title}: ${errs.map((e) => e.message).join("; ")}`);
        } else {
          merged += toDelete.length;
        }
      } catch (err) {
        failed += 1;
        userErrorMessages.push(`${product.title}: ${err?.message ?? "unknown"}`);
      }
    }
    return {
      ok: true,
      bulk,
      merged,
      failed,
      processedThisBatch: productsWithDupes.length,
      pageProductsScanned: products.length,
      totalProducts,
      cumulativeScanned: cumulativeScannedIn + products.length,
      cumulativeSaved: cumulativeSavedIn + (typeof saved !== 'undefined' ? saved : 0),
      cumulativeUnknown: cumulativeUnknownIn + (typeof unknown !== 'undefined' ? unknown : 0),
      cumulativeUpdated: cumulativeUpdatedIn + (typeof updated !== 'undefined' ? updated : 0),
      cumulativeMerged: cumulativeMergedIn + (typeof merged !== 'undefined' ? merged : 0),
      cumulativeFailed: cumulativeFailedIn + (typeof failed !== 'undefined' ? failed : 0),
      userErrors: userErrorMessages.slice(0, 5),
      nextCursor: endCursor,
      pageNumber: pageNumber + 1,
      hasMore: hasNextPage,
    };
  }

  // ─── SINGLE: save one product's colour AND/OR model (the dropdown forms) ──
  const productId = formData.get("productId");
  const colour = (formData.get("colour") ?? "").toString().trim();
  const model = (formData.get("model") ?? "").toString().trim();
  if (!productId || (!colour && !model)) {
    return { ok: false, error: "Missing productId / colour / model" };
  }
  if (model) {
    const r = await writeAssignedModel(admin, productId, model);
    if (!r.ok) return r;
  }
  if (colour) {
    const r = await writeAssignedColour(admin, productId, colour);
    if (!r.ok) return r;
  }
  return { ok: true, productId, colour: colour || null, model: model || null };
};


export default function Index() {
  const { products, pagination } = useLoaderData();
  const bulkFetcher = useFetcher();
  const [activeFilter, setActiveFilter] = useState("all");
  const [pipeline, setPipeline] = useState(null);

  const productPresentations = useMemo(
    () => products.map((product) => ({ product, presentation: getProductPresentation(product) })),
    [products],
  );

  const stats = productPresentations.reduce(
    (acc, { presentation }) => {
      if (presentation.effectiveStatus === "matched") acc.matched += 1;
      else if (presentation.effectiveStatus === "review") acc.review += 1;
      else acc.needsColour += 1;
      if (presentation.hasDuplicateGeneratedSkus) acc.duplicateSkuWarning += 1;
      return acc;
    },
    { matched: 0, needsColour: 0, review: 0, duplicateSkuWarning: 0 },
  );

  const filterDefinitions = [
    { key: "all", label: "All", count: productPresentations.length },
    { key: "safe-to-write", label: "Safe to write", count: productPresentations.filter(({ presentation }) => presentation.isSafeForSkuWrite).length },
    { key: "needs-colour", label: "Needs colour", count: productPresentations.filter(({ presentation }) => presentation.effectiveStatus === "needs-colour").length },
    { key: "review", label: "Review", count: productPresentations.filter(({ presentation }) => presentation.effectiveStatus === "review").length },
    { key: "duplicate-sku-warnings", label: "Duplicate variants", count: productPresentations.filter(({ presentation }) => presentation.hasDuplicateGeneratedSkus).length },
  ];

  const filteredProducts = productPresentations.filter(({ presentation }) => {
    if (activeFilter === "safe-to-write") return presentation.isSafeForSkuWrite;
    if (activeFilter === "needs-colour") return presentation.effectiveStatus === "needs-colour";
    if (activeFilter === "review") return presentation.effectiveStatus === "review";
    if (activeFilter === "duplicate-sku-warnings") return presentation.hasDuplicateGeneratedSkus;
    return true;
  });

  const data = bulkFetcher.data;
  const isBusy = bulkFetcher.state !== "idle";

  useEffect(() => {
    if (!data || isBusy) return;
    if (data.hasMore) {
      const fd = new FormData();
      fd.set("bulk", data.bulk);
      if (data.nextCursor) fd.set("cursor", data.nextCursor);
      fd.set("pageNumber", String(data.pageNumber ?? 1));
      fd.set("totalProducts", String(data.totalProducts ?? 0));
      fd.set("cumulativeScanned", String(data.cumulativeScanned ?? 0));
      fd.set("cumulativeSaved", String(data.cumulativeSaved ?? 0));
      fd.set("cumulativeUnknown", String(data.cumulativeUnknown ?? 0));
      fd.set("cumulativeUpdated", String(data.cumulativeUpdated ?? 0));
      fd.set("cumulativeMerged", String(data.cumulativeMerged ?? 0));
      fd.set("cumulativeFailed", String(data.cumulativeFailed ?? 0));
      bulkFetcher.submit(fd, { method: "post" });
      return;
    }
    if (pipeline && pipeline.idx + 1 < pipeline.steps.length) {
      const next = pipeline.steps[pipeline.idx + 1];
      setPipeline({ ...pipeline, idx: pipeline.idx + 1 });
      const fd = new FormData();
      fd.set("bulk", next);
      fd.set("pageNumber", "0");
      bulkFetcher.submit(fd, { method: "post" });
    } else if (pipeline) {
      setPipeline(null);
    }
  }, [data?.hasMore, data?.nextCursor, data?.pageNumber, data?.bulk, isBusy, pipeline]);

  // Programmatic submit used by the auto-continue effect (NOT for first click)
  function continueBulk(name, extra = {}) {
    const fd = new FormData();
    fd.set("bulk", name);
    fd.set("pageNumber", "0");
    Object.entries(extra).forEach(([k, v]) => fd.set(k, String(v)));
    bulkFetcher.submit(fd, { method: "post", action: "." });
  }
  // Buttons use the Form below, but we still need these for the auto-chain
  function startBulk(name) { setPipeline(null); continueBulk(name); }
  function startPipeline() {
    const steps = ["autoAssignConfident", "visionPassModels", "visionPass", "mergeDuplicateVariants"];
    setPipeline({ steps, idx: 0 });
    continueBulk(steps[0]);
  }

  const stepLabels = {
    autoAssignConfident: "1/4 dHash colour-assign",
    visionPassModels: "2/4 OpenAI MODEL identification",
    visionPass: "3/4 OpenAI COLOUR identification",
    mergeDuplicateVariants: "4/4 merging duplicate variants",
    writeSafeSkus: "Writing SKUs to Shopify",
  };

  return (
    <div style={{ padding: "1.6rem" }}>
      <datalist id="macron-models-list">
        {macronModelReferences.map((ref) => (
          <option key={ref.slug} value={ref.displayName} />
        ))}
      </datalist>
      <h1 style={{ fontSize: "1.75rem", marginBottom: "1rem" }}>MSH SKU Manager</h1>

      <div style={{ background: "white", border: "1px solid #dfe3e8", borderRadius: "12px", padding: "1.25rem", maxWidth: "780px" }}>
        <h2 style={{ fontSize: "1.25rem", marginTop: 0, marginBottom: "0.5rem" }}>SKU Dashboard</h2>
        <p style={{ marginTop: 0, marginBottom: "0.5rem", color: "#616161", fontSize: "0.875rem" }}>
          This page: {productPresentations.length} products . {stats.matched} matched . {stats.needsColour} need colour . {stats.review} review . {stats.duplicateSkuWarning} duplicate variants
        </p>

        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.75rem" }}>
          <bulkFetcher.Form method="post" onSubmit={() => setPipeline({ steps: ["autoAssignConfident", "visionPassModels", "visionPass", "mergeDuplicateVariants"], idx: 0 })}>
            <input type="hidden" name="bulk" value="autoAssignConfident" />
            <input type="hidden" name="pageNumber" value="0" />
            <button type="submit" disabled={isBusy} style={{ padding: "0.6rem 1.25rem", background: "#1a73e8", color: "white", border: "none", borderRadius: "6px", fontWeight: 600, cursor: isBusy ? "not-allowed" : "pointer" }}>
              Run all (steps 1-4)
            </button>
          </bulkFetcher.Form>
          <bulkFetcher.Form method="post" onSubmit={() => setPipeline(null)}>
            <input type="hidden" name="bulk" value="writeSafeSkus" />
            <input type="hidden" name="pageNumber" value="0" />
            <button type="submit" disabled={isBusy} style={{ padding: "0.6rem 1.25rem", background: "#1f8a4c", color: "white", border: "none", borderRadius: "6px", fontWeight: 600, cursor: isBusy ? "not-allowed" : "pointer" }}>
              Confirm and write SKUs to Shopify
            </button>
          </bulkFetcher.Form>
        </div>

        {data && data.totalProducts ? (() => {
          const pct = Math.min(100, Math.round((data.cumulativeScanned / data.totalProducts) * 100));
          const label = stepLabels[data.bulk] ?? data.bulk;
          const done = !data.hasMore && (!pipeline || pipeline.idx + 1 >= pipeline.steps.length);
          return (
            <div style={{ marginTop: "0.75rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.875rem", marginBottom: "0.25rem" }}>
                <span><strong>{label}</strong> . {data.cumulativeScanned} of {data.totalProducts} scanned</span>
                <span>{pct}%{done ? " done" : pipeline ? ` . step ${pipeline.idx + 1}/${pipeline.steps.length}` : ""}</span>
              </div>
              <div style={{ height: "10px", background: "#e8f0fe", borderRadius: "5px", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${pct}%`, background: done ? "#1f8a4c" : "#1a73e8", transition: "width 0.3s" }} />
              </div>
              <div style={{ marginTop: "0.4rem", fontSize: "0.8rem", color: "#555" }}>
                {data.cumulativeSaved ? <span>Saved: <strong>{data.cumulativeSaved}</strong> . </span> : null}
                {data.cumulativeUnknown ? <span>Unknown: <strong>{data.cumulativeUnknown}</strong> . </span> : null}
                {data.cumulativeUpdated ? <span>SKUs updated: <strong>{data.cumulativeUpdated}</strong> . </span> : null}
                {data.cumulativeMerged ? <span>Variants merged: <strong>{data.cumulativeMerged}</strong> . </span> : null}
                {data.cumulativeFailed ? <span style={{ color: "#a00" }}>Failed: <strong>{data.cumulativeFailed}</strong></span> : null}
              </div>
            </div>
          );
        })() : null}

        {data?.ok === false ? (
          <div style={{ marginTop: "0.75rem", padding: "0.5rem 0.75rem", background: "#fff0f0", color: "#a00", borderRadius: "6px", fontSize: "0.875rem" }}>
            Error: {data.error}
          </div>
        ) : null}

        <details style={{ marginTop: "0.75rem" }}>
          <summary style={{ cursor: "pointer", fontSize: "0.85rem", color: "#555" }}>Run individual steps</summary>
          <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", marginTop: "0.5rem" }}>
            {[
              { name: "autoAssignConfident", label: "1. dHash colour-assign" },
              { name: "visionPassModels", label: "2. Vision MODELS" },
              { name: "visionPass", label: "3. Vision COLOURS" },
              { name: "mergeDuplicateVariants", label: "4. Merge duplicates" },
            ].map((step) => (
              <bulkFetcher.Form key={step.name} method="post" onSubmit={() => setPipeline(null)}>
                <input type="hidden" name="bulk" value={step.name} />
                <input type="hidden" name="pageNumber" value="0" />
                <button type="submit" disabled={isBusy} style={{ padding: "0.4rem 0.8rem", fontSize: "0.85rem", cursor: isBusy ? "not-allowed" : "pointer" }}>
                  {step.label}
                </button>
              </bulkFetcher.Form>
            ))}
          </div>
        </details>

        <p style={{ margin: "0.75rem 0 0", fontSize: "0.8rem", color: "#a06600" }}>
          Click <strong>Run all</strong> to identify models, colours and clean duplicates automatically. When that finishes, click <strong>Confirm and write SKUs</strong> to push them to Shopify.
        </p>
      </div>

      <div style={{ marginTop: "1rem", maxWidth: "780px" }}>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.75rem" }}>
          {filterDefinitions.map((filter) => {
            const isActive = activeFilter === filter.key;
            return (
              <button
                key={filter.key}
                type="button"
                onClick={() => setActiveFilter(filter.key)}
                style={{ padding: "0.4rem 0.7rem", borderRadius: "999px", border: isActive ? "1px solid #1a73e8" : "1px solid #dfe3e8", background: isActive ? "#e8f0fe" : "white", color: "#303030", fontWeight: isActive ? 600 : 400, cursor: "pointer" }}
              >
                {filter.label} ({filter.count})
              </button>
            );
          })}
        </div>

        {pagination ? (
          <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem", fontSize: "0.875rem" }}>
            {pagination.currentCursor ? (
              <a href="/app" style={{ padding: "0.4rem 0.7rem", borderRadius: "6px", border: "1px solid #dfe3e8", textDecoration: "none", color: "#303030" }}>First page</a>
            ) : null}
            {pagination.hasMore ? (
              <a href={`/app?cursor=${encodeURIComponent(pagination.nextCursor)}`} style={{ padding: "0.4rem 0.7rem", borderRadius: "6px", border: "1px solid #dfe3e8", textDecoration: "none", color: "#303030" }}>Next page</a>
            ) : null}
          </div>
        ) : null}

        <div style={{ background: "white", border: "1px solid #dfe3e8", borderRadius: "12px", padding: "1rem" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            {filteredProducts.map(({ product, presentation }) => {
              const { parsed, effectiveColour, colourSource, effectiveStatus, effectiveReason, variantRows, hasDuplicateGeneratedSkus, isSafeForSkuWrite } = presentation;
              const statusColour = effectiveStatus === "matched" ? "#1f8a4c" : effectiveStatus === "review" ? "#a00" : "#a06600";
              return (
                <div key={product.id} style={{ borderTop: "1px solid #f0f0f0", paddingTop: "0.6rem" }}>
                  <p style={{ margin: 0, fontWeight: 700 }}>{product.title}</p>
                  <p style={{ margin: 0, fontSize: "0.8rem", color: "#888" }}>{product.handle}</p>
                  <div style={{ marginTop: "0.25rem", fontSize: "0.85rem", color: "#303030", lineHeight: 1.5 }}>
                    {parsed.club ? <span>Club: <strong>{parsed.club}</strong> | </span> : null}
                    {parsed.model ? <span>Model: <strong>{parsed.model}</strong>{presentation.modelSource === "assigned" ? " (assigned)" : ""} | </span> : null}
                    <span>Type: <strong>{parsed.type ?? "-"}</strong> | </span>
                    {effectiveColour ? <span>Colour: <strong>{effectiveColour}</strong>{colourSource && colourSource !== "title" ? ` (${colourSource})` : ""} | </span> : null}
                    <span style={{ color: statusColour }}>Status: <strong>{effectiveStatus}</strong></span>
                    {hasDuplicateGeneratedSkus ? <span style={{ color: "#a00" }}> | duplicate variants</span> : null}
                    {isSafeForSkuWrite ? <span style={{ color: "#1f8a4c" }}> | safe to write</span> : null}
                  </div>
                  {effectiveReason ? <p style={{ margin: "0.2rem 0 0", fontSize: "0.8rem", color: "#888" }}>{effectiveReason}</p> : null}
                  {effectiveStatus === "review" ? (
                    <Form method="post" style={{ marginTop: "0.4rem", display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                      <input type="hidden" name="productId" value={product.id} />
                      <input list="macron-models-list" name="model" placeholder="Type Macron model..." defaultValue={product.assignedModel ?? ""} style={{ padding: "0.25rem", minWidth: "200px" }} autoComplete="off" />
                      <button type="submit" style={{ padding: "0.25rem 0.75rem" }}>Save model</button>
                    </Form>
                  ) : null}
                  {effectiveStatus === "needs-colour" && parsed.allowedColours?.length > 0 ? (
                    <Form method="post" style={{ marginTop: "0.4rem", display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                      <input type="hidden" name="productId" value={product.id} />
                      <select name="colour" defaultValue={product.assignedColour ?? ""} style={{ padding: "0.25rem" }}>
                        <option value="">- pick colour -</option>
                        {parsed.allowedColours.map((c) => (<option key={c} value={c}>{c}</option>))}
                      </select>
                      <button type="submit" style={{ padding: "0.25rem 0.75rem" }}>Save colour</button>
                    </Form>
                  ) : null}
                  <details style={{ marginTop: "0.4rem", fontSize: "0.8rem", color: "#555" }}>
                    <summary style={{ cursor: "pointer" }}>{variantRows.length} variants</summary>
                    {variantRows.map((row, i) => {
                      const isDup = i > 0 && variantRows.slice(0, i).some((r) => r.generatedSku === row.generatedSku);
                      return (
                        <div key={row.id} style={{ paddingLeft: "1rem", opacity: isDup ? 0.5 : 1 }}>
                          {formatSizeLabel(row.variantSize)} -&gt; <code>{row.generatedSku}</code>{isDup ? " (dup)" : ""}
                        </div>
                      );
                    })}
                  </details>
                </div>
              );
            })}
            {filteredProducts.length === 0 ? <p style={{ color: "#888", margin: 0 }}>No products in this filter.</p> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
