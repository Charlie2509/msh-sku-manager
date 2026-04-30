# Visual Parse — setup

The dashboard now auto-runs perceptual-hash matching against the PIM image
library for every product that's missing a colour. Setup needed once:

## 1. Install `sharp`

```
npm install sharp
```

## 2. Build the image index (one-off, ~5–10 min)

This walks `pim_images/` and computes a 64-bit perceptual hash for every JPEG.

```
node scripts/index-pim-images.mjs
```

Defaults assume your image library lives at:
`C:\Users\Charlie\Desktop\New folder\macron_out\pim_images`

To use a different location:

```
node scripts/index-pim-images.mjs --images-dir "D:\path\to\pim_images"
```

Output: `app/data/pimImageIndex.json` (~3 MB)

## 3. Restart the dev server

```
npm run dev
```

Reload the embedded app — every `needs-colour` product now shows an
auto-detected colour with confidence percentage. Click **Save** to persist
to the `msh.assigned_colour` Shopify metafield.

## 4. Re-run the index when products change

If Macron adds new products or you add new colourways to your PIM library,
re-run step 2.

---

## What the dHash matcher can and can't do

**Can:** identify a clean Macron product image as the same product.
Distance ≤12 of 64 bits is a strong match.

**Can't:** reliably identify a customised product (with club logo, sponsor,
player name) as the matching base product. Pixel-based hashing isn't
overlay-tolerant. For those, we need an embedding-based matcher (CLIP,
DINO, or a vision LLM like GPT-4o / Claude vision).

**Recommended next step (when ready):** plug in OpenAI or Anthropic vision
API as a second-stage disambiguator for low-confidence dHash matches. See
`app/lib/imageMatcher.server.js` for where to hook this in.

## CLI test

To test matching without spinning up the app:

```
node scripts/match-product-image.mjs --url https://your-shopify-cdn.com/products/some-image.jpg --top 5
```

Returns top-5 PIM matches with distances and confidence scores.
