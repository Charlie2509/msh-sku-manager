#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const DEFAULT_MAX_LINKS = Number.parseInt(process.env.DIAGNOSE_MAX_LINKS ?? "5", 10);
const ASSETS_DIR = "extracted_assets";
const DIAGNOSTICS_DIR = path.join(ASSETS_DIR, "diagnostics");
const INPUT_SUMMARY_PATH = path.join(ASSETS_DIR, "input_summary.json");

const INPUT_CANDIDATES = [
  path.join(ASSETS_DIR, "product_links.json"),
  path.join(ASSETS_DIR, "pdf_links.json"),
  "pdf_links.json",
  path.join(ASSETS_DIR, "all_product_links.txt"),
  "all_product_links.txt",
];

const isValidHttpUrl = (value) => {
  if (typeof value !== "string") {
    return false;
  }

  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

const normalizeUrl = (value) => {
  if (typeof value !== "string") {
    return null;
  }

  const cleaned = value.trim().replace(/[)>\]}'",;]+$/g, "");
  if (!cleaned) {
    return null;
  }

  try {
    return new URL(cleaned).toString();
  } catch {
    return null;
  }
};

const productCodeFromUrl = (url, index) => {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const last = parts.at(-1) || `product-${index + 1}`;
    return last.replace(/[^a-zA-Z0-9_-]/g, "_");
  } catch {
    return `product-${index + 1}`;
  }
};

const extractLinks = (input) => {
  if (Array.isArray(input)) {
    return input
      .map((entry) => {
        if (typeof entry === "string") {
          return entry;
        }

        if (entry && typeof entry === "object") {
          return entry.url || entry.link || entry.productUrl || entry.product_url || null;
        }

        return null;
      })
      .filter(Boolean);
  }

  if (input && typeof input === "object") {
    const nestedKeys = ["links", "products", "items", "data"];

    for (const key of nestedKeys) {
      if (Array.isArray(input[key])) {
        return extractLinks(input[key]);
      }
    }
  }

  return [];
};

const parseJoinedLinksFromText = (contents) => {
  const candidateUrls = [];

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const matches = trimmed.match(/https?:\/\/[\w\d\-._~:/?#\[\]@!$&'()*+,;=%]+/g);
    if (matches && matches.length > 0) {
      candidateUrls.push(...matches);
    }
  }

  return candidateUrls;
};

const dedupeLinks = (links, sourceAttribution = new Map()) => {
  const seen = new Set();
  const unique = [];

  for (const link of links) {
    const normalized = normalizeUrl(link);
    if (!normalized || !isValidHttpUrl(normalized) || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    unique.push(normalized);
  }

  return {
    unique,
    sourceAttribution,
  };
};

const fileExists = async (filePath) => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

const loadFromProductLinksJson = async (filePath) => {
  const fileContents = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(fileContents);
  const links = extractLinks(parsed);
  return { links, source: path.basename(filePath), sourceAttribution: new Map() };
};

const loadFromPdfLinksJson = async (filePath) => {
  const fileContents = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(fileContents);

  const flattened = [];
  const sourceAttribution = new Map();

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    for (const [catalogue, urls] of Object.entries(parsed)) {
      if (!Array.isArray(urls)) {
        continue;
      }

      for (const url of urls) {
        flattened.push(url);
        if (typeof url === "string") {
          const normalized = normalizeUrl(url);
          if (normalized) {
            const current = sourceAttribution.get(normalized) ?? new Set();
            current.add(catalogue);
            sourceAttribution.set(normalized, current);
          }
        }
      }
    }
  }

  return { links: flattened, source: path.basename(filePath), sourceAttribution };
};

const loadFromAllProductLinksTxt = async (filePath) => {
  const fileContents = await fs.readFile(filePath, "utf8");
  const links = parseJoinedLinksFromText(fileContents);
  return { links, source: path.basename(filePath), sourceAttribution: new Map() };
};

const loadProductLinks = async () => {
  const linksFromEnv = process.env.PRODUCT_LINKS;

  if (linksFromEnv) {
    const envLinks = linksFromEnv
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

    return {
      source: "PRODUCT_LINKS env",
      rawLinks: envLinks,
      uniqueLinks: dedupeLinks(envLinks).unique,
      sourceAttribution: new Map(),
    };
  }

  for (const candidate of INPUT_CANDIDATES) {
    if (!(await fileExists(candidate))) {
      continue;
    }

    const loader = candidate.endsWith("product_links.json")
      ? loadFromProductLinksJson
      : candidate.endsWith("pdf_links.json")
        ? loadFromPdfLinksJson
        : loadFromAllProductLinksTxt;

    const loaded = await loader(candidate);
    const deduped = dedupeLinks(loaded.links, loaded.sourceAttribution);

    return {
      source: loaded.source,
      rawLinks: loaded.links,
      uniqueLinks: deduped.unique,
      sourceAttribution: deduped.sourceAttribution,
    };
  }

  return {
    source: "none",
    rawLinks: [],
    uniqueLinks: [],
    sourceAttribution: new Map(),
  };
};

const writeInputSummary = async ({ source, rawLinks, uniqueLinks, sourceAttribution }) => {
  const sampleLinks = uniqueLinks.slice(0, 5);
  const sourceSamples = sampleLinks.map((link) => ({
    link,
    catalogues: sourceAttribution.get(link) ? Array.from(sourceAttribution.get(link)).sort() : [],
  }));

  const summary = {
    input_source: source,
    raw_count: rawLinks.length,
    unique_count: uniqueLinks.length,
    sample_links: sampleLinks,
    sample_sources: sourceSamples,
  };

  await fs.writeFile(INPUT_SUMMARY_PATH, JSON.stringify(summary, null, 2), "utf8");
};

const logHeader = (message) => {
  console.log("\n" + "=".repeat(80));
  console.log(message);
  console.log("=".repeat(80));
};

const run = async () => {
  await fs.mkdir(ASSETS_DIR, { recursive: true });
  await fs.mkdir(DIAGNOSTICS_DIR, { recursive: true });

  const loaded = await loadProductLinks();
  await writeInputSummary(loaded);

  const validLinks = loaded.uniqueLinks.slice(0, DEFAULT_MAX_LINKS);

  if (validLinks.length === 0) {
    console.error(
      `No valid links found. Checked: ${INPUT_CANDIDATES.join(", ")} (or PRODUCT_LINKS env var with HTTP/HTTPS URLs).`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `Loaded ${loaded.rawLinks.length} raw links (${loaded.uniqueLinks.length} unique) from ${loaded.source}. Running diagnostics for ${validLinks.length} links.`,
  );

  const browser = await chromium.launch({ headless: true });

  for (const [index, link] of validLinks.entries()) {
    const productCode = productCodeFromUrl(link, index);
    const screenshotPath = path.join(DIAGNOSTICS_DIR, `${productCode}.png`);
    const htmlPath = path.join(DIAGNOSTICS_DIR, `${productCode}.html`);

    logHeader(`Diagnosing ${index + 1}/${validLinks.length}: ${link}`);

    const page = await browser.newPage();

    const consoleErrors = [];
    const failedRequests = [];
    const imageResponses = [];
    const apiResponses = [];

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const entry = `[console.error] ${msg.text()}`;
        consoleErrors.push(entry);
        console.log(entry);
      }
    });

    page.on("requestfailed", (request) => {
      const failureText = request.failure()?.errorText ?? "unknown";
      const entry = `[request.failed] ${request.method()} ${request.url()} :: ${failureText}`;
      failedRequests.push(entry);
      console.log(entry);
    });

    page.on("response", (response) => {
      const url = response.url();
      const status = response.status();
      const request = response.request();
      const resourceType = request.resourceType();
      const headers = response.headers();
      const contentType = headers["content-type"] ?? "unknown";

      if (contentType.startsWith("image/")) {
        const entry = `[image.response] ${status} ${url} :: ${contentType}`;
        imageResponses.push(entry);
        console.log(entry);
      }

      if (
        resourceType === "xhr" ||
        resourceType === "fetch" ||
        contentType.includes("application/json") ||
        contentType.includes("text/json")
      ) {
        const entry = `[api.response] ${status} ${url} :: ${resourceType}`;
        apiResponses.push(entry);
        console.log(entry);
      }
    });

    let gotoResponse;

    try {
      gotoResponse = await page.goto(link, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.waitForTimeout(2_000);

      const status = gotoResponse?.status() ?? "no-response";
      const finalUrl = page.url();
      const title = await page.title();

      console.log(`[main.status] ${status}`);
      console.log(`[final.url] ${finalUrl}`);
      console.log(`[page.title] ${title || "(empty title)"}`);
    } catch (error) {
      console.error(`[navigation.error] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }

    const html = await page.content();
    await fs.writeFile(htmlPath, html, "utf8");
    await page.screenshot({ path: screenshotPath, fullPage: true });

    console.log(`[saved.screenshot] ${screenshotPath}`);
    console.log(`[saved.html] ${htmlPath}`);
    console.log(
      `[summary] consoleErrors=${consoleErrors.length} failedRequests=${failedRequests.length} imageResponses=${imageResponses.length} apiResponses=${apiResponses.length}`,
    );

    await page.close();
  }

  await browser.close();
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
