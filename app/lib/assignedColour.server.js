export const ASSIGNED_COLOUR_NAMESPACE = "msh";
export const ASSIGNED_COLOUR_KEY = "assigned_colour";
export const ASSIGNED_MODEL_KEY = "assigned_model";

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
