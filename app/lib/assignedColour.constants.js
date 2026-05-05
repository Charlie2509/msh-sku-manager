// Constants shared between client & server — must NOT have a .server.js suffix
// otherwise React Router refuses to bundle them for the client.
export const ASSIGNED_COLOUR_NAMESPACE = "msh";
export const ASSIGNED_COLOUR_KEY = "assigned_colour";
export const ASSIGNED_MODEL_KEY = "assigned_model";
// For non-Macron / shop-branded products: the user enters a custom SKU stem
// (e.g. "pirates-cap-3d") and we use it directly instead of looking up a
// Macron model. Colour and size are still appended.
export const ASSIGNED_SKU_STEM_KEY = "assigned_sku_stem";
