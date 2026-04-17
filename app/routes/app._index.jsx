import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";

const COLOURS = ["BLACK", "RED", "BLUE", "GREEN", "WHITE"];
const PRODUCT_TYPES = ["JACKET", "HOODY", "COAT", "GLOVES", "CAP", "HAT", "SOCKS"];

function parseProductTitle(title) {
  const words = title.split(/\s+/).filter(Boolean);
  const upperWords = words.map((word) => word.toUpperCase());

  const typeIndex = upperWords.findIndex((word) => PRODUCT_TYPES.includes(word));
  const colourIndex = upperWords.findIndex((word) => COLOURS.includes(word));

  const modelIndex =
    typeIndex !== -1
      ? upperWords.findIndex(
          (word, index) =>
            index > typeIndex && !PRODUCT_TYPES.includes(word) && !COLOURS.includes(word),
        )
      : -1;

  const club =
    modelIndex > 0
      ? words.slice(0, modelIndex).join(" ")
      : typeIndex > 0
        ? words.slice(0, typeIndex).join(" ")
        : "N/A";
  const model = modelIndex !== -1 ? words[modelIndex] : "N/A";
  const type = typeIndex !== -1 ? words[typeIndex] : "N/A";
  const colour = colourIndex !== -1 ? words[colourIndex] : "N/A";

  return { club, model, type, colour };
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
        <s-card>
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
                    <p style={{ margin: 0 }}>→ Club: {parsed.club}</p>
                    <p style={{ margin: 0 }}>→ Model: {parsed.model}</p>
                    <p style={{ margin: 0 }}>→ Type: {parsed.type}</p>
                    <p style={{ margin: 0 }}>→ Colour: {parsed.colour}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </s-card>
      </div>
    </div>
  );
}
