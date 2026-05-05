/**
 * In-app editor for the Macron model reference.
 *
 * The static reference (~600 models) is auto-generated from the brochure
 * extraction. This page lets you ADD new models and OVERRIDE existing ones
 * (e.g. when next year's brochure introduces new colourways or products) by
 * writing to app/data/macronReferenceOverrides.json.
 *
 * No new build/deploy needed — entries take effect on the next page load.
 */
import { useState } from "react";
import { Form, useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import { listOverrides, upsertOverride, deleteOverride } from "../lib/referenceOverrides.server";
import { macronReferenceData } from "../data/macronReference";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const overrides = await listOverrides();
  // Combine static + overrides for display, with a flag so we can show which is which
  const staticEntries = Object.entries(macronReferenceData).map(([slug, e]) => ({
    slug,
    displayName: e.displayName,
    garmentType: e.garmentType,
    allowedColours: e.allowedColours || [],
    aliases: e.aliases || [],
    source: "static",
    overridden: slug in overrides,
  }));
  const overrideEntries = Object.entries(overrides)
    .filter(([slug]) => !(slug in macronReferenceData))
    .map(([slug, e]) => ({
      slug,
      displayName: e.displayName,
      garmentType: e.garmentType,
      allowedColours: e.allowedColours || [],
      aliases: e.aliases || [],
      source: "user",
      overridden: false,
    }));
  // Merge: user-only first, then statics. Sort by name within each group.
  const merged = [
    ...overrideEntries.sort((a, b) => a.displayName.localeCompare(b.displayName)),
    ...staticEntries.sort((a, b) => a.displayName.localeCompare(b.displayName)),
  ];
  // Inject the live override values for static entries that have been overridden,
  // so the UI shows what they currently resolve to.
  for (const m of merged) {
    if (m.source === "static" && m.overridden) {
      const o = overrides[m.slug];
      m.displayName = o.displayName;
      m.garmentType = o.garmentType;
      m.allowedColours = o.allowedColours || [];
      m.aliases = o.aliases || [];
    }
  }
  return { entries: merged, overrideCount: Object.keys(overrides).length };
};

export const action = async ({ request }) => {
  await authenticate.admin(request);
  const fd = await request.formData();
  const op = fd.get("op")?.toString();
  if (op === "delete") {
    const slug = fd.get("slug")?.toString();
    return await deleteOverride(slug);
  }
  // Default: upsert
  const slug = fd.get("slug")?.toString();
  const displayName = fd.get("displayName")?.toString();
  const garmentType = fd.get("garmentType")?.toString();
  const allowedColours = fd.get("allowedColours")?.toString().split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  const aliases = fd.get("aliases")?.toString().split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  return await upsertOverride({ slug, displayName, garmentType, allowedColours, aliases });
};

export default function ReferenceEditor() {
  const { entries, overrideCount } = useLoaderData();
  const fetcher = useFetcher();
  const [filter, setFilter] = useState("");
  const [showOnly, setShowOnly] = useState("all"); // all | overrides | static
  const [editingSlug, setEditingSlug] = useState(null);

  const filtered = entries.filter((e) => {
    if (showOnly === "overrides" && e.source !== "user" && !e.overridden) return false;
    if (showOnly === "static" && e.source !== "static") return false;
    if (!filter) return true;
    const f = filter.toLowerCase();
    return e.displayName.toLowerCase().includes(f) || e.slug.includes(f);
  });

  return (
    <div style={{ padding: "1.6rem", maxWidth: "900px" }}>
      <h1 style={{ fontSize: "1.75rem", marginBottom: "0.5rem" }}>Macron Reference Editor</h1>
      <p style={{ color: "#616161", fontSize: "0.875rem", marginTop: 0 }}>
        Static catalogue: {entries.length - overrideCount} models · User overrides/additions: {overrideCount} · <a href="/app">← Back to dashboard</a>
      </p>

      {/* Add new model form */}
      <details style={{ background: "white", border: "1px solid #dfe3e8", borderRadius: "8px", padding: "1rem", marginBottom: "1rem" }}>
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>+ Add a new Macron model</summary>
        <fetcher.Form method="post" style={{ marginTop: "0.75rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <label>
            Display name (e.g. "Olympus Hero")
            <input name="displayName" required style={{ display: "block", padding: "0.4rem", width: "100%", marginTop: "0.2rem" }} />
          </label>
          <label>
            Garment type (e.g. "t-shirt", "polo shirt", "jacket", "socks")
            <input name="garmentType" defaultValue="unknown" style={{ display: "block", padding: "0.4rem", width: "100%", marginTop: "0.2rem" }} />
          </label>
          <label>
            Allowed colours (comma-separated, e.g. "WHITE, NAVY, BLACK, WHITE/NAVY")
            <input name="allowedColours" placeholder="WHITE, NAVY, BLACK" style={{ display: "block", padding: "0.4rem", width: "100%", marginTop: "0.2rem" }} />
          </label>
          <label>
            Aliases (comma-separated alternative names, optional)
            <input name="aliases" placeholder="olympushero, olympus-hero" style={{ display: "block", padding: "0.4rem", width: "100%", marginTop: "0.2rem" }} />
          </label>
          <button type="submit" style={{ padding: "0.5rem 1rem", background: "#1f8a4c", color: "white", border: "none", borderRadius: "6px", cursor: "pointer", alignSelf: "flex-start" }}>
            Add model
          </button>
        </fetcher.Form>
      </details>

      {/* Filters */}
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
        <input
          type="search"
          placeholder="Search models…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ padding: "0.4rem", flex: "1", minWidth: "200px" }}
        />
        <select value={showOnly} onChange={(e) => setShowOnly(e.target.value)} style={{ padding: "0.4rem" }}>
          <option value="all">All ({entries.length})</option>
          <option value="overrides">User-added / overridden</option>
          <option value="static">Static only</option>
        </select>
      </div>

      {fetcher.data?.ok ? (
        <div style={{ padding: "0.5rem", background: "#e6f4ea", color: "#1f8a4c", borderRadius: "6px", marginBottom: "0.75rem" }}>
          ✓ Saved
        </div>
      ) : null}
      {fetcher.data?.ok === false ? (
        <div style={{ padding: "0.5rem", background: "#fdecea", color: "#a00", borderRadius: "6px", marginBottom: "0.75rem" }}>
          ✗ {fetcher.data.error}
        </div>
      ) : null}

      <div style={{ background: "white", border: "1px solid #dfe3e8", borderRadius: "8px", overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
          <thead>
            <tr style={{ background: "#f6f6f6", textAlign: "left" }}>
              <th style={{ padding: "0.5rem" }}>Name</th>
              <th style={{ padding: "0.5rem" }}>Garment type</th>
              <th style={{ padding: "0.5rem" }}>Colours</th>
              <th style={{ padding: "0.5rem" }}>Source</th>
              <th style={{ padding: "0.5rem" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, 200).map((entry) => {
              const isEditing = editingSlug === entry.slug;
              return (
                <tr key={entry.slug} style={{ borderTop: "1px solid #f0f0f0" }}>
                  {isEditing ? (
                    <td colSpan={5} style={{ padding: "0.75rem", background: "#fffbe6" }}>
                      <fetcher.Form method="post" onSubmit={() => setEditingSlug(null)}>
                        <input type="hidden" name="slug" value={entry.slug} />
                        <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: "0.5rem", alignItems: "center" }}>
                          <span>Slug:</span> <code>{entry.slug}</code>
                          <span>Display:</span> <input name="displayName" defaultValue={entry.displayName} style={{ padding: "0.3rem" }} />
                          <span>Garment:</span> <input name="garmentType" defaultValue={entry.garmentType} style={{ padding: "0.3rem" }} />
                          <span>Colours:</span> <input name="allowedColours" defaultValue={(entry.allowedColours || []).join(", ")} style={{ padding: "0.3rem" }} />
                          <span>Aliases:</span> <input name="aliases" defaultValue={(entry.aliases || []).join(", ")} style={{ padding: "0.3rem" }} />
                        </div>
                        <div style={{ marginTop: "0.5rem", display: "flex", gap: "0.5rem" }}>
                          <button type="submit" style={{ padding: "0.4rem 0.75rem", background: "#1f8a4c", color: "white", border: "none", borderRadius: "4px" }}>Save</button>
                          <button type="button" onClick={() => setEditingSlug(null)} style={{ padding: "0.4rem 0.75rem" }}>Cancel</button>
                        </div>
                      </fetcher.Form>
                    </td>
                  ) : (
                    <>
                      <td style={{ padding: "0.5rem" }}><strong>{entry.displayName}</strong><br /><code style={{ fontSize: "0.75rem", color: "#888" }}>{entry.slug}</code></td>
                      <td style={{ padding: "0.5rem" }}>{entry.garmentType}</td>
                      <td style={{ padding: "0.5rem", maxWidth: "300px", fontSize: "0.8rem" }}>{(entry.allowedColours || []).join(", ") || <span style={{ color: "#bbb" }}>(none)</span>}</td>
                      <td style={{ padding: "0.5rem" }}>
                        {entry.source === "user" ? <span style={{ background: "#e6f4ea", color: "#1f8a4c", padding: "2px 6px", borderRadius: "4px", fontSize: "0.75rem" }}>USER</span>
                          : entry.overridden ? <span style={{ background: "#fff3cd", color: "#a06600", padding: "2px 6px", borderRadius: "4px", fontSize: "0.75rem" }}>STATIC + OVERRIDDEN</span>
                          : <span style={{ color: "#888", fontSize: "0.75rem" }}>static</span>}
                      </td>
                      <td style={{ padding: "0.5rem", whiteSpace: "nowrap" }}>
                        <button type="button" onClick={() => setEditingSlug(entry.slug)} style={{ padding: "0.3rem 0.6rem", marginRight: "0.3rem" }}>Edit</button>
                        {(entry.source === "user" || entry.overridden) ? (
                          <fetcher.Form method="post" style={{ display: "inline" }} onSubmit={(e) => { if (!confirm(`Remove override for ${entry.displayName}?`)) e.preventDefault(); }}>
                            <input type="hidden" name="op" value="delete" />
                            <input type="hidden" name="slug" value={entry.slug} />
                            <button type="submit" style={{ padding: "0.3rem 0.6rem", color: "#a00" }}>Remove</button>
                          </fetcher.Form>
                        ) : null}
                      </td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
        {filtered.length > 200 ? (
          <p style={{ padding: "0.5rem", color: "#888", fontSize: "0.8rem", margin: 0 }}>Showing first 200 of {filtered.length}. Use search to narrow down.</p>
        ) : null}
        {filtered.length === 0 ? (
          <p style={{ padding: "1rem", color: "#888", margin: 0 }}>No models match.</p>
        ) : null}
      </div>
    </div>
  );
}
