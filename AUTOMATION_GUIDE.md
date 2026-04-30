# MSH SKU Manager — automation guide

The dashboard is now structured around three buttons that do nearly everything
automatically. Edge cases (the few products neither dHash nor Claude can
classify) come down to a manual dropdown click.

## The three buttons

### 1. Auto-assign confident matches
Runs the dHash matcher across every product, and writes the assigned-colour
metafield for every product where:
- the match is the *same* Macron product family the title parser detected, **and**
- the matched colour is one of the model's allowed colourways, **and**
- the dHash distance is ≤12 of 64 bits (a strong match).

Free, fast (~10 seconds for 250 products), zero false positives in practice
because of the three-condition gate above.

### 2. Run vision pass (Claude)
For any product still missing a colour, sends the product image + allowed
colours list to Claude vision. Claude is asked to ignore club badges,
sponsors, and personalisation and just identify the base fabric colour.

Costs ~£0.005 per image (results are cached forever in
`app/data/visionCache.json`, so each image only costs once even across runs).
Solves the navy/black confusion and customised-product edge cases.

**Setup:** add to `.env`:
```
ANTHROPIC_API_KEY=sk-ant-...
```
Get a key at https://console.anthropic.com. £5 of credit covers ~1000 images.
The button is disabled and shows "ANTHROPIC_API_KEY not set" if missing.

### 3. Manual dropdown per product
For the remaining handful of products neither pass could resolve — usually
products with no Macron model name in the title (e.g. *"HILLCREST ABC SNR
COTTON TEE"*), or products genuinely missing the right reference data.

## Recommended workflow

1. Click **Auto-assign confident matches** → most products resolved
2. Click **Run vision pass (Claude)** → most edge cases resolved
3. Manually pick the colour from the dropdown for the few left

## Going live (dev → production)

When you're ready to launch the live store, all the heavy work transfers:
- Code, image index, macron reference data, dHash matcher, Claude integration
  all carry over as-is
- `app/data/visionCache.json` carries over too — no Claude bills get repeated

The one thing you have to migrate is the metafield assignments themselves,
since Shopify product IDs are different per store. Use:

```
# On the dev store
SHOP=dev-store.myshopify.com ACCESS_TOKEN=shpat_dev \
  node scripts/export-assignments.mjs --out assignments.json

# On the live store
SHOP=live-store.myshopify.com ACCESS_TOKEN=shpat_live \
  node scripts/import-assignments.mjs --in assignments.json
```

Add `--dry-run` to the import command first to see what would change without
writing anything.

If your live store's product titles + handles match the dev store's, you can
also just re-run the three buttons on live — the dHash + cached Claude
results will reproduce the same assignments without any new API calls.

## Files

| File | Purpose |
|---|---|
| `app/routes/app._index.jsx` | Dashboard, parser, action handlers |
| `app/data/macronReference.js` | 601 Macron models with allowed colours |
| `app/data/pimImageIndex.json` | dHash index of 9,129 PIM photos |
| `app/data/visionCache.json` | Claude vision response cache (auto-created) |
| `app/lib/imageMatcher.server.js` | dHash matcher logic |
| `app/lib/visionLlm.server.js` | Claude vision second-stage classifier |
| `scripts/index-pim-images.mjs` | One-off indexer (run when PIM library updates) |
| `scripts/match-product-image.mjs` | CLI test of the dHash matcher |
| `scripts/export-assignments.mjs` | Dev → production migration export |
| `scripts/import-assignments.mjs` | Dev → production migration import |
