import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";

const genders = ["SNR", "JNR"];
const colours = ["BLACK", "RED", "BLUE", "GREEN", "WHITE"];
const types = [
  "JACKET",
  "COAT",
  "BENCHCOAT",
  "SHOWERJACKET",
  "HOODY",
  "HOODIE",
  "GLOVES",
  "CAP",
  "HAT",
  "SOCKS",
  "BACKPACK",
  "RUCKSACK",
  "POM",
  "POM POM",
  "POLO SHIRT",
  "BODY WARMER",
  "TRAVEL RUCKSACK",
  "BASEBALL CAP",
  "BOBBLE HAT",
  "BOBBLE",
  "MATCH SOCKS",
  "NECKWARMER",
  "TARGET SOCK",
  "SOCK",
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

function deriveStatus({ model, type, colour }) {
  const upperModel = model?.toUpperCase() ?? null;
  const isSuspiciousModel = upperModel ? suspiciousModelWords.has(upperModel) : false;

  if (!model || isSuspiciousModel) {
    return "review";
  }

  if (type && colour) {
    return "matched";
  }

  return "partial";
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

function parseFallbackProductTitle(words, typeInfo = null) {
  const upperWords = words.map((word) => word.toUpperCase());
  const detectedColour = upperWords.find((word) => colours.includes(word)) ?? null;
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

  return {
    club: null,
    model: resolvedModel,
    type: resolvedType,
    colour: detectedColour,
    status: deriveStatus({ model: resolvedModel, type: resolvedType, colour: detectedColour }),
  };
}

function parseProductTitle(title) {
  const words = title.split(/\s+/).filter(Boolean);
  const upperWords = words.map((word) => word.toUpperCase());

  const genderIndex = upperWords.findIndex((word) => genders.includes(word));
  const modelIndex = genderIndex !== -1 ? genderIndex + 1 : -1;
  const typeInfo = detectType(words);
  const typeWordIndexSet = new Set(typeInfo.typeWordIndices);

  const clubWords = genderIndex > 0 ? words.slice(0, genderIndex) : [];
  const club = clubWords.length > 0 ? clubWords.join(" ") : null;
  const directModelCandidate = modelIndex !== -1 && modelIndex < words.length ? words[modelIndex] : null;
  const directModelUpper = directModelCandidate?.toUpperCase() ?? null;
  const model =
    directModelCandidate &&
    isStrongModelWord(directModelCandidate) &&
    !typeWordIndexSet.has(modelIndex) &&
    directModelUpper &&
    !modelStopWords.includes(directModelUpper)
      ? directModelCandidate
      : null;

  const wordsAfterModel =
    modelIndex !== -1 && modelIndex + 1 < words.length ? upperWords.slice(modelIndex + 1) : [];
  const typeSegment = wordsAfterModel.join(" ").trim();

  const sortedTypes = [...types].sort((a, b) => b.length - a.length);
  const detectedType = typeInfo.type ?? sortedTypes.find((candidateType) => typeSegment.includes(candidateType));
  const detectedColour = upperWords.find((word) => colours.includes(word));

  const type = detectedType ?? (typeSegment || null);
  const colour = detectedColour ?? null;

  if (model) {
    return { club, model, type, colour, status: deriveStatus({ model, type, colour }) };
  }

  return parseFallbackProductTitle(words, typeInfo);
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
      products(first: 20) {
        edges {
          node {
            id
            title
            handle
            variants(first: 10) {
              edges {
                node {
                  id
                  title
                  sku
                }
              }
            }
          }
        }
      }
    }
  `);

  const responseJson = await response.json();
  const products = responseJson.data.products.edges.map(({ node }) => node);

  return { products };
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
              const parsed = parseProductTitle(product.title);

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
                    {parsed.colour ? <p style={{ margin: 0 }}>→ Colour: {parsed.colour}</p> : null}
                    <p style={{ margin: 0 }}>→ Status: {parsed.status}</p>
                  </div>
                  <div style={{ marginTop: "0.5rem", fontSize: "0.875rem", color: "#303030" }}>
                    <p style={{ margin: 0, fontWeight: 600 }}>Variants:</p>
                    {product.variants.edges.map(({ node: variant }) => {
                      const generatedSku = generateVariantSku({
                        model: parsed.model,
                        colour: parsed.colour,
                        size: variant.title,
                      });

                      return (
                        <p key={variant.id} style={{ margin: 0 }}>
                          - Size: {variant.title} → SKU: {generatedSku}
                        </p>
                      );
                    })}
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
