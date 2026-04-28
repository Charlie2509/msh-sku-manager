#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const DEFAULT_LINKS_FILE = process.env.PRODUCT_LINKS_FILE ?? "extracted_assets/product_links.json";
const DEFAULT_MAX_LINKS = Number.parseInt(process.env.DIAGNOSE_MAX_LINKS ?? "5", 10);
const DIAGNOSTICS_DIR = "extracted_assets/diagnostics";

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

const loadProductLinks = async () => {
  const linksFromEnv = process.env.PRODUCT_LINKS;

  if (linksFromEnv) {
    return linksFromEnv
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  const fileContents = await fs.readFile(DEFAULT_LINKS_FILE, "utf8");
  const parsed = JSON.parse(fileContents);
  return extractLinks(parsed);
};

const logHeader = (message) => {
  console.log("\n" + "=".repeat(80));
  console.log(message);
  console.log("=".repeat(80));
};

const run = async () => {
  await fs.mkdir(DIAGNOSTICS_DIR, { recursive: true });

  const loadedLinks = await loadProductLinks();
  const validLinks = loadedLinks.filter(isValidHttpUrl).slice(0, DEFAULT_MAX_LINKS);

  if (validLinks.length === 0) {
    console.error(
      `No valid links found. Expected ${DEFAULT_LINKS_FILE} or PRODUCT_LINKS env var with HTTP/HTTPS URLs.`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`Loaded ${loadedLinks.length} links. Running diagnostics for ${validLinks.length} links.`);

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
    console.log(`[summary] consoleErrors=${consoleErrors.length} failedRequests=${failedRequests.length} imageResponses=${imageResponses.length} apiResponses=${apiResponses.length}`);

    await page.close();
  }

  await browser.close();
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
