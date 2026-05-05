// Re-export the constants from the non-server file so existing imports keep working.
export { ASSIGNED_COLOUR_NAMESPACE, ASSIGNED_COLOUR_KEY, ASSIGNED_MODEL_KEY, ASSIGNED_SKU_STEM_KEY } from "./assignedColour.constants";
import { ASSIGNED_COLOUR_NAMESPACE, ASSIGNED_COLOUR_KEY, ASSIGNED_MODEL_KEY, ASSIGNED_SKU_STEM_KEY } from "./assignedColour.constants";

async function setMetafield(admin, productId, key, value) {
  const response = await admin.graphql(
    `#graphql
    mutation SetMeta($metafields: [MetafieldsSetInput!]!) {
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
            key,
            type: "single_line_text_field",
            value,
          },
        ],
      },
    },
  );
  const json = await response.json();
  const errors = json?.data?.metafieldsSet?.userErrors ?? [];
  return errors.length > 0 ? { ok: false, error: errors.map((e) => e.message).join("; ") } : { ok: true };
}

export async function writeAssignedColour(admin, productId, colour) {
  return setMetafield(admin, productId, ASSIGNED_COLOUR_KEY, colour);
}

export async function writeAssignedModel(admin, productId, model) {
  return setMetafield(admin, productId, ASSIGNED_MODEL_KEY, model);
}

export async function writeAssignedSkuStem(admin, productId, stem) {
  return setMetafield(admin, productId, ASSIGNED_SKU_STEM_KEY, stem);
}
