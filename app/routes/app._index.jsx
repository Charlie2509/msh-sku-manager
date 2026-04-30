import { Form, useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import { macronReferenceMap } from "../data/macronReference";

const ASSIGNED_COLOUR_NAMESPACE = "msh";
const ASSIGNED_COLOUR_KEY = "assigned_colour";

const genders = ["SNR", "JNR"];
const colours = [
  "BLACK",
  "WHITE",
  "RED",
  "GREEN",
  "BLUE",
  "NAVY",
  "ROYAL",
  "SKY",
  "YELLOW",
  "ORANGE",
  "MAROON",
  "PINK",
  "PURPLE",
  "GREY",
  "GRAY",
];
const types = [
  "JACKET","PADDED JACKET","WINTER THERMAL JACKET","TRAINING JACKET","RAIN JACKET","SHOWER JACKET",
  "COAT","WINTER COAT","LONG COAT","BENCHCOAT","BENCH COAT","LONG BENCHCOAT","SHOWERJACKET",
  "HOODY","HOODIE","HOODED TRACKSUIT TOP",
  "GLOVES",
  "CAP","BASEBALL CAP","TRUCKER CAP",
  "HAT","BOBBLE HAT","WINTER BOBBLE HAT","BOBBLE","BUCKET HAT",
  "SOCKS","MATCH SOCKS","SHORT SOCKS","TRAINING SOCKS","ANKLE SOCK","FIXED ANKLE SOCK","TARGET SOCK","SOCK",
  "BACKPACK","RUCKSACK","TRAVEL RUCKSACK","HOLDALL","GYM KIT BAG","KIT BAG","SHOULDER BAG","BAG",
  "POM","POM POM","NECKWARMER","BEANIE",
  "POLO SHIRT","SHIRT","TEE","T-SHIRT","COTTON TEE","TRAINING TEE","TRAINING SWEATER",
  "BODY WARMER","BODYWARMER","GILET",
  "TRAINING SHORTS","TRAINING TOP","TRAINING PANTS","TRAINING BOTTOMS","SHORTS",
  "TRACKSUIT","TRACKSUIT TOP","TRACKSUIT BOTTOMS","TRACKSUIT BOTTOM","TRACK PANTS","TROUSERS","PANTS",
  "WATER BOTTLE","BOTTLE",
  "1/4 ZIP TOP","FULL ZIP TOP","SWEATSHIRT","SWEATER",
  "TOP","BOTTOMS",
];
const modelStopWords = ["WINTER", "BOBBLE", "GAME", "DAY", "TARGET", "3D", "EMBROIDERED", "LONG"];
const removableWords = [
  "FC",
  "AFC",
  "UNITED",
  "COACHES",
  "PLAYERS",
  "GIRLS",
  "CONNECT",
  "PIRATES",
  "EASTBOURNE",
  "HASTINGS",
  "FOREST",
  "ROW",
];
const suspiciousModelWords = new Set(["3D"]);
function isStrongModelWord(word) {
  const trimmedWord = word?.trim();
  if (!trimmedWord) return false;
  return /[A-Z]/i.test(trimmedWord) && /^[A-Z0-9-]+$/i.test(trimmedWord);
}

function toComparableToken(value) {
  return value?.toUpperCase().replace(/[^A-Z0-9]/g, "") ?? "";
}

function detectColour(words, handle = "") {
  const upperTitleWords = words.map((word) => toComparableToken(word));
  const colourFromTitle = upperTitleWords.find((word) => colours.includes(word));
  if (colourFromTitle) return colourFromTitle;

  const handleParts = handle
    .split("-")
    .map((part) => toComparableToken(part))
    .filter(Boolean);
  const colourFromHandle = handleParts.find((part) => colours.includes(part));
  return colourFromHandle ?? null;
}

function getModelReference(model) {
  if (!model) return null;
  return macronReferenceMap[model.toLowerCase()] ?? null;
}

// Try to find a multi-word Macron model in the title (e.g. "ROUND EVO", "RIGEL HERO")
function detectMacronModelFromTitle(words) {
  if (!words || words.length === 0) return null;
  const lowerTokens = words.map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, ""));
  // Try 3-, 2-, then 1-word slices, prefer longer matches
  for (const span of [3, 2, 1]) {
    for (let i = 0; i <= lowerTokens.length - span; i += 1) {
      const slice = lowerTokens.slice(i, i + span).filter(Boolean);
      if (slice.length === 0) continue;
      const candidates = [
        slice.join("-"),
        slice.join(" "),
        slice.join(""),
      ];
      for (const candidate of candidates) {
        const ref = macronReferenceMap[candidate];
        if (ref) {
          // Return the original-cased word(s) so display stays nice
          const original = words.slice(i, i + span).join(" ");
          return { model: original, modelIndices: Array.from({ length: span }, (_, k) => i + k), reference: ref };
        }
      }
    }
  }
  return null;
}

// Pull colour from Shopify variant selectedOptions (any option named like 'color' / 'colour')
function detectColourFromVariant(variant, allowedColours) {
  if (!variant?.selectedOptions) return null;
  for (const opt of variant.selectedOptions) {
    const optName = (opt.name || "").toLowerCase();
    if (optName.includes("color") || optName.includes("colour")) {
      const value = (opt.value || "").trim().toUpperCase();
      if (!value) continue;
      // Validate against allowedColours if provided
      if (allowedColours && allowedColours.length > 0) {
        const match = allowedColours.find((c) => c.toUpperCase() === value || value.includes(c.toUpperCase()));
        if (match) return match;
      }
      return value;
    }
  }
  return null;
}

// Pull size from variant — prefer selectedOptions named 'size'
function detectSizeFromVariant(variant) {
  if (variant?.selectedOptions) {
    for (const opt of variant.selectedOptions) {
      if ((opt.name || "").toLowerCase() === "size" && opt.value) return opt.value;
    }
  }
  return variant?.title ?? null;
}

function attachModelReference(parsedResult) {
  if (!parsedResult.model) return parsedResult;

  const modelReference = getModelReference(parsedResult.model);
  return {
    ...parsedResult,
    modelReference,
    allowedColours: modelReference?.allowedColours ?? null,
  };
}

function getAllowedColoursMessage(parsedResult) {
  if (!parsedResult.modelReference) {
    return "unknown";
  }

  if (!parsedResult.allowedColours || parsedResult.allowedColours.length === 0) {
    return "pending catalogue import";
  }

  return parsedResult.allowedColours.join(", ");
}

function deriveParseMeta({ model, type, colour }) {
  const upperModel = model?.toUpperCase() ?? null;
  const isSuspiciousModel = upperModel ? suspiciousModelWords.has(upperModel) : false;

  if (!model) {
    return { status: "review", partialReason: "missing model" };
  }

  if (isSuspiciousModel) {
    return { status: "review", partialReason: "generic/review item" };
  }

  if (type && colour) {
    return { status: "matched", partialReason: null };
  }

  if (type && !colour) {
    return { status: "partial", partialReason: "missing colour" };
  }

  return { status: "partial", partialReason: null };
}

function detectType(words) {
  const upperWords = words.map((word) => word.toUpperCase());
  const sortedTypes = [...types].sort((a, b) => b.length - a.length);

  for (const candidateType of sortedTypes) {
    const typeWords = candidateType.split(/\s+/);
    for (let index = 0; index <= upperWords.length - typeWords.length; index += 1) {
      const matchesType = typeWords.every((typeWord, offset) => upperWords[index + offset] === typeWord);
      if (matchesType) {
        const typeWordIndices = typeWords.map((_, offset) => index + offset);
        return { type: candidateType, typeWords, typeWordIndices };
      }
    }
  }

  return { type: null, typeWords: [], typeWordIndices: [] };
}

function parseFallbackProductTitle(words, handle = "", typeInfo = null) {
  const upperWords = words.map((word) => toComparableToken(word));
  const detectedColour = detectColour(words, handle);
  const {
    type: detectedType,
    typeWords,
    typeWordIndices,
  } = typeInfo ?? detectType(words);
  const typeWordIndexSet = new Set(typeWordIndices);
  const hasBobbleAndSnow = upperWords.includes("BOBBLE") && upperWords.includes("SNOW");

  const removableWordsSet = new Set([
    ...removableWords,
    ...genders,
    ...(detectedColour ? [detectedColour] : []),
    ...typeWords,
    ...modelStopWords,
  ]);

  const model =
    words.find((word, index) => {
      const upperWord = word.toUpperCase();
      if (typeWordIndexSet.has(index)) return false;
      return isStrongModelWord(word) && !removableWordsSet.has(upperWord);
    }) ?? null;
  const preferredWinterModel = hasBobbleAndSnow ? words.find((word) => word.toUpperCase() === "SNOW") : null;
  const resolvedModel = preferredWinterModel ?? model;
  const resolvedType = detectedType ?? (upperWords.includes("BOBBLE") ? "BOBBLE HAT" : null);
  const parseMeta = deriveParseMeta({
    model: resolvedModel,
    type: resolvedType,
    colour: detectedColour,
  });

  return attachModelReference({
    club: null,
    model: resolvedModel,
    type: resolvedType,
    colour: detectedColour,
    status: parseMeta.status,
    partialReason: parseMeta.partialReason,
  });
}

function parseProductTitle(title, handle = "") {
  const words = title.split(/\s+/).filter(Boolean);
  const upperWords = words.map((word) => word.toUpperCase());

  const genderIndex = upperWords.findIndex((word) => genders.includes(word));
  const modelIndex = genderIndex !== -1 ? genderIndex + 1 : -1;
  const typeInfo = detectType(words);
  const typeWordIndexSet = new Set(typeInfo.typeWordIndices);

  const clubWords = genderIndex > 0 ? words.slice(0, genderIndex) : [];
  const club = clubWords.length > 0 ? clubWords.join(" ") : null;

  // First try to find a known Macron model (multi-word aware) anywhere in the title
  const macronHit = detectMacronModelFromTitle(words);
  const directModelCandidate = modelIndex !== -1 && modelIndex < words.length ? words[modelIndex] : null;
  const directModelUpper = directModelCandidate?.toUpperCase() ?? null;
  const directModelOK =
    directModelCandidate &&
    isStrongModelWord(directModelCandidate) &&
    !typeWordIndexSet.has(modelIndex) &&
    directModelUpper &&
    !modelStopWords.includes(directModelUpper);
  const model = macronHit?.model ?? (directModelOK ? directModelCandidate : null);

  const wordsAfterModel =
    modelIndex !== -1 && modelIndex + 1 < words.length ? upperWords.slice(modelIndex + 1) : [];
  const typeSegment = wordsAfterModel.join(" ").trim();

  const sortedTypes = [...types].sort((a, b) => b.length - a.length);
  const detectedType = typeInfo.type ?? sortedTypes.find((candidateType) => typeSegment.includes(candidateType));
  const detectedColour = detectColour(words, handle);

  const type = detectedType ?? (typeSegment || null);
  const colour = detectedColour ?? null;
  const parseMeta = deriveParseMeta({ model, type, colour });

  if (model) {
    return attachModelReference({
      club,
      model,
      type,
      colour,
      status: parseMeta.status,
      partialReason: parseMeta.partialReason,
    });
  }

  return parseFallbackProductTitle(words, handle, typeInfo);
}

function normaliseSkuPart(value, fallback = "na") {
  if (!value) return fallback;
  const cleaned = value.toString().trim().toLowerCase().replace(/\s+/g, "");
  return cleaned || fallback;
}

function normalizeSize(sizeValue) {
  if (!sizeValue) return "na";

  const rawSize = sizeValue.toString().trim();
  if (!rawSize) return "na";

  const normalizedKey = rawSize.toLowerCase().replace(/\s+/g, " ").trim();
  const directMap = {
    small: "s",
    s: "s",
    medium: "m",
    m: "m",
    large: "l",
    l: "l",
    xl: "xl",
    "2xl": "2xl",
    "3xl": "3xl",
    "4xl": "4xl",
    "5xl": "5xl",
    default: "one",
    jnr: "jnr",
    snr: "snr",
  };

  if (directMap[normalizedKey]) {
    return directMap[normalizedKey];
  }

  // Handle sock/number-range values (e.g. "MEDIUM 5-8 UK", "XS UK 10.5-2")
  // by converting named sizes and cleaning the rest for SKU safety.
  let working = normalizedKey;
  const prefixMap = [
    { from: "small", to: "s" },
    { from: "medium", to: "m" },
    { from: "large", to: "l" },
  ];

  prefixMap.forEach(({ from, to }) => {
    const prefixRegex = new RegExp(`\\b${from}\\b`, "g");
    working = working.replace(prefixRegex, to);
  });

  working = working
    .replace(/\buk\b/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/\./g, "_")
    .replace(/-+/g, "-");

  return working || "na";
}

function generateVariantSku({ model, colour, size }) {
  const modelPart = normaliseSkuPart(model);
  const colourPart = normaliseSkuPart(colour);
  const sizePart = normalizeSize(size);

  return `${modelPart}-${colourPart}-${sizePart}`;
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

  return { products };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const productId = formData.get("productId");
  const colour = (formData.get("colour") ?? "").toString().trim();

  if (!productId || !colour) {
    return { ok: false, error: "Missing productId or colour" };
  }

  const response = await admin.graphql(
    `#graphql
    mutation SetAssignedColour($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
        metafields { id namespace key value }
      }
    }`,
    {
      variables: {
        metafields: [
          {
            ownerId: productId,
            namespace: ASSIGNED_COLOUR_NAMESPACE,
            key: ASSIGNED_COLOUR_KEY,
            type: "single_line_text_field",
            value: colour,
          },
        ],
      },
    },
  );

  const json = await response.json();
  const errors = json?.data?.metafieldsSet?.userErrors ?? [];
  if (errors.length > 0) {
    return { ok: false, error: errors.map((e) => e.message).join("; ") };
  }
  return { ok: true, productId, colour };
};

export default function Index() {
  const { products } = useLoaderData();

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
          App connected successfully
        </p>
        <div style={{ display: "flex", gap: "0.75rem" }}>
          <button type="button">Scan catalogue</button>
          <button type="button">Review queue</button>
        </div>
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
              const parsed = parseProductTitle(product.title, product.handle);

              // If title didn't yield a colour but variants have a Color option, treat as matched
              const variantColours = (product.variants?.edges ?? [])
                .map(({ node }) => detectColourFromVariant(node, parsed.allowedColours))
                .filter(Boolean);
              // Priority: title-detected colour > variant Color option > assigned-colour metafield
              const effectiveColour =
                parsed.colour ?? variantColours[0] ?? product.assignedColour ?? null;
              const colourSource = parsed.colour
                ? "title"
                : variantColours.length
                  ? "variant"
                  : product.assignedColour
                    ? "assigned"
                    : null;
              // Detect whether the product has a Color option at all (not just per variant)
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
              }

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
                    {["partial", "review", "needs-colour"].includes(effectiveStatus) && effectiveReason ? (
                      <p style={{ margin: 0 }}>→ Reason: {effectiveReason}</p>
                    ) : null}
                    {(effectiveStatus === "partial" || effectiveStatus === "needs-colour") && parsed.modelReference ? (
                      <p style={{ margin: 0 }}>
                        → Allowed colours: {getAllowedColoursMessage(parsed)}
                      </p>
                    ) : null}

                    {effectiveStatus === "needs-colour" && parsed.allowedColours?.length > 0 ? (
                      <Form method="post" style={{ marginTop: "0.5rem", display: "flex", gap: "0.5rem", alignItems: "center" }}>
                        <input type="hidden" name="productId" value={product.id} />
                        <label style={{ fontSize: "0.875rem", color: "#303030" }}>
                          Assign colour:
                          <select
                            name="colour"
                            defaultValue={product.assignedColour ?? ""}
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
                    ) : null}
                  </div>
                  <div style={{ marginTop: "0.5rem", fontSize: "0.875rem", color: "#303030" }}>
                    <p style={{ margin: 0, fontWeight: 600 }}>Variants:</p>
                    {(() => {
                      const seen = new Set();
                      return product.variants.edges.map(({ node: variant }) => {
                        // Prefer Shopify variant options over title parsing,
                        // then fall back to assigned-colour metafield (effectiveColour).
                        const variantColour = detectColourFromVariant(variant, parsed.allowedColours);
                        const variantSize = detectSizeFromVariant(variant);
                        const finalColour = variantColour ?? effectiveColour;
                        const generatedSku = generateVariantSku({
                          model: parsed.model,
                          colour: finalColour,
                          size: variantSize,
                        });
                        // Dedupe identical SKUs (e.g. variants 's' and 'Small' both normalise to '-s')
                        const dedupeKey = generatedSku;
                        const isDuplicate = seen.has(dedupeKey);
                        seen.add(dedupeKey);
                        return (
                          <p key={variant.id} style={{ margin: 0, opacity: isDuplicate ? 0.45 : 1 }}>
                            - Size: {variantSize}{variantColour ? ` · Colour: ${variantColour}` : ""} → SKU: {generatedSku}{isDuplicate ? " (dup)" : ""}
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
