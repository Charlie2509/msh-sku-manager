import { Form, useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import { suggestColourFromImage } from "../lib/imageMatcher.server";
import { isVisionLlmEnabled, classifyColourWithVision } from "../lib/visionLlm.server";
import { ASSIGNED_COLOUR_NAMESPACE, ASSIGNED_COLOUR_KEY, writeAssignedColour } from "../lib/assignedColour.server";
import { detectColour, detectColourFromVariant, detectSizeFromVariant, formatSizeLabel, getAllowedColoursMessage, normalizeColourDisplay, parseProductTitle } from "../lib/skuParser";
import { generateVariantSku } from "../lib/skuGenerator";

// dHash distance threshold (out of 64 bits). Below this we trust the suggestion enough
// to display it boldly; above, we mark it low-confidence.
const STRONG_MATCH_DISTANCE = 12;
const DUPLICATE_SKU_WARNING = "Duplicate generated SKUs detected — do not auto-write until variants are cleaned.";

function getProductPresentation(product) {
  const parsed = parseProductTitle(product.title, product.handle);
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
    effectiveReason = "missing model / possible non-Macron product";
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
  const isSafeForSkuWrite = (
    effectiveStatus === "matched"
    && Boolean(parsed.model)
    && Boolean(effectiveColour)
    && !hasDuplicateGeneratedSkus
    && !hasNaGeneratedSku
    && !hasEmptyGeneratedSku
  );
  return {
    parsed,
    normalizedAssignedColour,
    effectiveColour,
    colourSource,
    hasColorOption,
    effectiveStatus,
    effectiveReason,
    variantRows,
    hasDuplicateGeneratedSkus,
    isSafeForSkuWrite,
  };
}

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const response = await admin.graphql(`
    #graphql
    query DashboardProducts {
      products(first: 50) {
        edges {
          node {
            id
            title
            handle
            featuredImage { url altText }
            options { name values }
            assignedColour: metafield(namespace: "${ASSIGNED_COLOUR_NAMESPACE}", key: "${ASSIGNED_COLOUR_KEY}") {
              value
            }
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
    }
  `);

  const responseJson = await response.json();
  const products = responseJson.data.products.edges.map(({ node }) => ({
    ...node,
    assignedColour: node.assignedColour?.value ?? null,
  }));

  // For each product, auto-run dHash visual matching against the PIM image library.
  // Runs in parallel; gracefully no-ops if the index isn't built yet.
  await Promise.all(
    products.map(async (p) => {
      if (p.assignedColour) return; // already assigned by user — nothing to do
      const parsed = parseProductTitle(p.title, p.handle);
      if (!parsed.model || !parsed.allowedColours?.length) return;
      // Only auto-match for products that look like they need a colour assigned
      const hasColorOption = (p.options ?? []).some((o) =>
        ["color", "colour"].includes((o.name || "").toLowerCase()),
      );
      const titleColour = detectColour(p.title.split(/\s+/), p.handle);
      if (titleColour || hasColorOption) return;
      const imageUrl = p.featuredImage?.url;
      if (!imageUrl) return;
      const suggestion = await suggestColourFromImage(
        imageUrl,
        parsed.modelReference?.slug ?? null,
        parsed.allowedColours,
      );
      if (suggestion) {
        p.suggestion = suggestion;
        p.suggestion.isStrong = suggestion.distance <= STRONG_MATCH_DISTANCE;
      }
    }),
  );

  return { products };
};

/**
 * Helper: re-fetch every product (id, title, handle, image, allowed colours,
 * existing assigned colour) so a bulk action can iterate over them.
 */
async function fetchAllProductsForBulk(admin) {
  const r = await admin.graphql(`
    #graphql
    query AllProducts {
      products(first: 250) {
        edges {
          node {
            id
            title
            handle
            featuredImage { url }
            options { name }
            assignedColour: metafield(namespace: "${ASSIGNED_COLOUR_NAMESPACE}", key: "${ASSIGNED_COLOUR_KEY}") { value }
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
    }
  `);
  const json = await r.json();
  return json.data.products.edges.map(({ node }) => ({
    ...node,
    assignedColour: node.assignedColour?.value ?? null,
  }));
}

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const bulk = formData.get("bulk")?.toString();

  // ─── BULK: auto-assign all confident dHash matches ────────────────────────
  if (bulk === "autoAssignConfident") {
    const products = await fetchAllProductsForBulk(admin);
    let saved = 0;
    let skipped = 0;
    await Promise.all(
      products.map(async (p) => {
        if (p.assignedColour) return; // already assigned, leave alone
        const parsed = parseProductTitle(p.title, p.handle);
        if (!parsed.model || !parsed.allowedColours?.length) return;
        const hasColorOption = (p.options ?? []).some((o) =>
          ["color", "colour"].includes((o.name || "").toLowerCase()),
        );
        const titleColour = detectColour(p.title.split(/\s+/), p.handle);
        if (titleColour || hasColorOption) return;
        if (!p.featuredImage?.url) return;
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
    return { ok: true, bulk, saved, skipped, total: products.length };
  }

  // ─── BULK: vision-LLM second-stage pass for low-confidence items ──────────
  if (bulk === "visionPass") {
    if (!isVisionLlmEnabled()) {
      return { ok: false, error: "OPENAI_API_KEY not set in environment" };
    }
    const products = await fetchAllProductsForBulk(admin);
    let saved = 0;
    let unknown = 0;
    let skipped = 0;
    // Run sequentially — OpenAI calls are slow and we want polite rate
    for (const p of products) {
      if (p.assignedColour) { skipped += 1; continue; }
      const parsed = parseProductTitle(p.title, p.handle);
      if (!parsed.model || !parsed.allowedColours?.length) { skipped += 1; continue; }
      if (!p.featuredImage?.url) { skipped += 1; continue; }
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
    return { ok: true, bulk, saved, unknown, skipped, total: products.length };
  }

  if (bulk === "writeSafeSkus") {
    const products = await fetchAllProductsForBulk(admin);
    let updated = 0;
    let skipped = 0;
    let failed = 0;

    for (const product of products) {
      const presentation = getProductPresentation(product);
      if (!presentation.isSafeForSkuWrite) continue;
      for (const row of presentation.variantRows) {
        if (!row.inventoryItemId) {
          skipped += 1;
          continue;
        }
        if (row.existingSku === row.generatedSku || row.inventoryItemSku === row.generatedSku) {
          skipped += 1;
          continue;
        }
        const resp = await admin.graphql(
          `#graphql
          mutation inventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
            inventoryItemUpdate(id: $id, input: $input) {
              inventoryItem {
                id
                sku
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
              id: row.inventoryItemId,
              input: {
                sku: row.generatedSku,
              },
            },
          },
        );
        const json = await resp.json();
        const errors = json?.data?.inventoryItemUpdate?.userErrors ?? [];
        if (errors.length) {
          failed += 1;
        } else {
          updated += 1;
        }
      }
    }
    return { ok: true, bulk, updated, skipped, failed };
  }

  // ─── SINGLE: save one product's colour (the existing dropdown form) ───────
  const productId = formData.get("productId");
  const colour = (formData.get("colour") ?? "").toString().trim();
  if (!productId || !colour) {
    return { ok: false, error: "Missing productId or colour" };
  }
  const r = await writeAssignedColour(admin, productId, colour);
  if (!r.ok) return r;
  return { ok: true, productId, colour };
};

export default function Index() {
  const { products } = useLoaderData();
  const bulkFetcher = useFetcher();

  // Quick stats for the dashboard summary
  const stats = products.reduce(
    (acc, p) => {
      const presentation = getProductPresentation(p);
      if (presentation.effectiveStatus === "matched") acc.matched += 1;
      else if (presentation.effectiveStatus === "review") acc.review += 1;
      else acc.needsColour += 1;
      if (presentation.hasDuplicateGeneratedSkus) acc.duplicateSkuWarning += 1;
      return acc;
    },
    { matched: 0, needsColour: 0, review: 0, duplicateSkuWarning: 0 },
  );

  return (
    <div style={{ padding: "1.6rem" }}>
      <h1 style={{ fontSize: "1.75rem", marginBottom: "1rem" }}>MSH SKU Manager</h1>
      <div
        style={{
          background: "white",
          border: "1px solid #dfe3e8",
          borderRadius: "12px",
          padding: "1.25rem",
          maxWidth: "640px",
        }}
      >
        <h2 style={{ fontSize: "1.25rem", marginTop: 0, marginBottom: "0.5rem" }}>
          SKU Dashboard
        </h2>
        <p style={{ marginTop: 0, marginBottom: "1rem", color: "#616161" }}>
          ✅ {stats.matched} matched · ⚠ {stats.needsColour} need colour · 🔍 {stats.review} review · ⚠ {stats.duplicateSkuWarning} duplicate SKU warnings
        </p>
        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
          <bulkFetcher.Form method="post">
            <input type="hidden" name="bulk" value="autoAssignConfident" />
            <button type="submit" disabled={bulkFetcher.state !== "idle"} style={{ padding: "0.5rem 1rem" }}>
              {bulkFetcher.state !== "idle" && bulkFetcher.formData?.get("bulk") === "autoAssignConfident"
                ? "Working…"
                : "Auto-assign confident matches"}
            </button>
          </bulkFetcher.Form>
          <bulkFetcher.Form method="post">
            <input type="hidden" name="bulk" value="visionPass" />
            <button type="submit" disabled={bulkFetcher.state !== "idle"} style={{ padding: "0.5rem 1rem" }}>
              {bulkFetcher.state !== "idle" && bulkFetcher.formData?.get("bulk") === "visionPass"
                ? "Asking OpenAI…"
                : "Run vision pass (OpenAI)"}
            </button>
          </bulkFetcher.Form>
          <bulkFetcher.Form method="post">
            <input type="hidden" name="bulk" value="writeSafeSkus" />
            <button type="submit" disabled={bulkFetcher.state !== "idle"} style={{ padding: "0.5rem 1rem" }}>
              {bulkFetcher.state !== "idle" && bulkFetcher.formData?.get("bulk") === "writeSafeSkus"
                ? "Writing SKUs…"
                : "Write safe SKUs to Shopify"}
            </button>
          </bulkFetcher.Form>
        </div>
        <p style={{ margin: "0.75rem 0 0", fontSize: "0.875rem", color: "#a06600" }}>
          Only matched products without duplicate warnings will be updated.
        </p>
        {bulkFetcher.data?.bulk === "autoAssignConfident" ? (
          <p style={{ margin: "0.75rem 0 0", fontSize: "0.875rem", color: "#1f8a4c" }}>
            ✓ Auto-assigned {bulkFetcher.data.saved} of {bulkFetcher.data.total} (skipped {bulkFetcher.data.skipped})
          </p>
        ) : null}
        {bulkFetcher.data?.bulk === "visionPass" ? (
          <p style={{ margin: "0.75rem 0 0", fontSize: "0.875rem", color: bulkFetcher.data.ok ? "#1f8a4c" : "#a00" }}>
            {bulkFetcher.data.ok
              ? `✓ OpenAI assigned ${bulkFetcher.data.saved} (${bulkFetcher.data.unknown} unknown, ${bulkFetcher.data.skipped} skipped)`
              : `✗ ${bulkFetcher.data.error}`}
          </p>
        ) : null}
        {bulkFetcher.data?.bulk === "writeSafeSkus" ? (
          <p style={{ margin: "0.75rem 0 0", fontSize: "0.875rem", color: bulkFetcher.data.ok ? "#1f8a4c" : "#a00" }}>
            {bulkFetcher.data.ok
              ? `Updated ${bulkFetcher.data.updated} variants. Skipped ${bulkFetcher.data.skipped}. Failed ${bulkFetcher.data.failed}.`
              : `✗ ${bulkFetcher.data.error}`}
          </p>
        ) : null}
      </div>

      <div style={{ marginTop: "1rem", maxWidth: "640px" }}>
        <div
          style={{
            background: "white",
            border: "1px solid #dfe3e8",
            borderRadius: "12px",
            padding: "1rem",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            {products.map((product) => {
              const {
                parsed,
                normalizedAssignedColour,
                effectiveColour,
                colourSource,
                effectiveStatus,
                effectiveReason,
                variantRows,
                hasDuplicateGeneratedSkus,
                isSafeForSkuWrite,
              } = getProductPresentation(product);

              return (
                <div key={product.id}>
                  <p style={{ margin: 0, fontWeight: 700 }}>{product.title}</p>
                  <p style={{ margin: 0, fontSize: "0.875rem", color: "#616161" }}>
                    {product.handle}
                  </p>
                  <div style={{ marginTop: "0.25rem", fontSize: "0.875rem", color: "#303030" }}>
                    {parsed.club ? <p style={{ margin: 0 }}>→ Club: {parsed.club}</p> : null}
                    {parsed.model ? <p style={{ margin: 0 }}>→ Model: {parsed.model}</p> : null}
                    <p style={{ margin: 0 }}>→ Type: {parsed.type ?? ""}</p>
                    {effectiveColour ? (
                      <p style={{ margin: 0 }}>
                        → Colour: {effectiveColour}
                        {colourSource && colourSource !== "title" ? ` (from ${colourSource})` : ""}
                      </p>
                    ) : null}
                    <p style={{ margin: 0 }}>→ Status: {effectiveStatus}</p>
                    <p style={{ margin: 0 }}>→ Safe for SKU write: {isSafeForSkuWrite ? "yes" : "no"}</p>
                    {hasDuplicateGeneratedSkus ? <p style={{ margin: 0, color: "#a00" }}>→ duplicate-sku-warning: {DUPLICATE_SKU_WARNING}</p> : null}
                    {["partial", "review", "needs-colour"].includes(effectiveStatus) && effectiveReason ? (
                      <p style={{ margin: 0 }}>→ Reason: {effectiveReason}</p>
                    ) : null}
                    {(effectiveStatus === "partial" || effectiveStatus === "needs-colour") && parsed.modelReference ? (
                      <p style={{ margin: 0 }}>
                        → Allowed colours: {getAllowedColoursMessage(parsed)}
                      </p>
                    ) : null}

                    {effectiveStatus === "needs-colour" && parsed.allowedColours?.length > 0 ? (
                      <div style={{ marginTop: "0.5rem", padding: "0.5rem", background: "#f6f6f6", borderRadius: "6px" }}>
                        {product.suggestion ? (
                          <p style={{ margin: 0, fontSize: "0.875rem" }}>
                            🔍 Auto-detected from image:{" "}
                            <strong>{product.suggestion.colour}</strong>{" "}
                            <span style={{ color: product.suggestion.isStrong && product.suggestion.validatedAgainstAllowed ? "#1f8a4c" : "#a06600" }}>
                              ({Math.round(product.suggestion.confidence * 100)}% confidence
                              {product.suggestion.scopedToExpectedProduct ? "" : ", different model"}
                              {!product.suggestion.validatedAgainstAllowed ? ", NOT in allowed colours — override below" : ""})
                            </span>
                          </p>
                        ) : (
                          <p style={{ margin: 0, fontSize: "0.875rem", color: "#a06600" }}>
                            ⚠ No image suggestion (run scripts/index-pim-images.mjs first, or no featured image on product)
                          </p>
                        )}
                        <Form method="post" style={{ marginTop: "0.4rem", display: "flex", gap: "0.5rem", alignItems: "center" }}>
                          <input type="hidden" name="productId" value={product.id} />
                          <label style={{ fontSize: "0.875rem", color: "#303030" }}>
                            {product.suggestion ? "Accept or override:" : "Assign colour:"}
                            <select
                              name="colour"
                              defaultValue={
                                (product.suggestion?.validatedAgainstAllowed ? product.suggestion.colour : null)
                                ?? normalizedAssignedColour
                                ?? ""
                              }
                              style={{ marginLeft: "0.5rem", padding: "0.25rem" }}
                            >
                              <option value="">— pick —</option>
                              {parsed.allowedColours.map((c) => (
                                <option key={c} value={c}>{c}</option>
                              ))}
                            </select>
                          </label>
                          <button type="submit" style={{ padding: "0.25rem 0.75rem" }}>
                            Save
                          </button>
                        </Form>
                      </div>
                    ) : null}
                  </div>
                  <div style={{ marginTop: "0.5rem", fontSize: "0.875rem", color: "#303030" }}>
                    <p style={{ margin: 0, fontWeight: 600 }}>Variants:</p>
                    {(() => {
                      const seen = new Set();
                      return variantRows.map((row) => {
                        const isDuplicate = seen.has(row.generatedSku);
                        seen.add(row.generatedSku);
                        const shouldHideGeneratedSku = (
                          effectiveStatus === "review"
                          || (effectiveStatus === "needs-colour" && row.generatedSku?.toLowerCase().includes("na"))
                        );
                        const skuMessage = effectiveStatus === "review"
                          ? "SKU: not generated — review required"
                          : "SKU: pending colour assignment";
                        return (
                          <p key={row.id} style={{ margin: 0, opacity: isDuplicate ? 0.45 : 1 }}>
                            - Size: {formatSizeLabel(row.variantSize)}{row.variantColour ? ` · Colour: ${row.variantColour}` : ""} → {shouldHideGeneratedSku ? skuMessage : `SKU: ${row.generatedSku}`}{isDuplicate ? " (dup)" : ""}
                          </p>
                        );
                      });
                    })()}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
