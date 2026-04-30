export const ASSIGNED_COLOUR_NAMESPACE = "msh";
export const ASSIGNED_COLOUR_KEY = "assigned_colour";

export async function writeAssignedColour(admin, productId, colour) {
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
  return errors.length > 0 ? { ok: false, error: errors.map((e) => e.message).join("; ") } : { ok: true };
}
