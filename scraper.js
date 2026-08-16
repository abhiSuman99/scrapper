const { chromium } = require("playwright");
const cheerio = require("cheerio");
const fs = require("fs");

const BASE_URL = "https://www.toolsvilla.com";
const SITEMAP_URL = `${BASE_URL}/sitemap/sitemap.xml`;

const TARGET_PRODUCTS = 5000;

// Keep this slow while testing.
// We can optimize it after everything works.
const DELAY_MS = 1000;

const JSON_FILE = "products.json";
const CSV_FILE = "products.csv";


// ======================================================
// HELPERS
// ======================================================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function absoluteUrl(url) {
  try {
    return new URL(url, BASE_URL).href;
  } catch {
    return "";
  }
}

function getNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const cleaned = String(value)
    .replace(/,/g, "")
    .replace(/[^\d.]/g, "");

  if (!cleaned) {
    return null;
  }

  const number = parseFloat(cleaned);

  return Number.isFinite(number)
    ? number
    : null;
}


// ======================================================
// CSV
// ======================================================

function csvEscape(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return "";
  }

  let output = value;

  if (Array.isArray(output)) {
    output = output.join(" | ");
  }

  if (typeof output === "object") {
    output = JSON.stringify(output);
  }

  output = String(output);

  return `"${output.replace(/"/g, '""')}"`;
}

function saveCSV(products) {
  const headers = [
    "url",
    "product_id",
    "sku",
    "name",
    "brand",
    "category",
    "subcategory",
    "breadcrumbs",
    "mrp",
    "selling_price",
    "discount_percentage",
    "currency",
    "availability",
    "rating",
    "review_count",
    "short_description",
    "description",
    "specifications",
    "images",
    "scraped_at"
  ];

  const lines = [];

  lines.push(
    headers
      .map(csvEscape)
      .join(",")
  );

  for (const product of products) {
    lines.push(
      headers
        .map((header) =>
          csvEscape(product[header])
        )
        .join(",")
    );
  }

  fs.writeFileSync(
    CSV_FILE,
    lines.join("\n"),
    "utf8"
  );
}


// ======================================================
// JSON-LD
// ======================================================

function extractJsonLd($) {
  const results = [];

  $('script[type="application/ld+json"]').each(
    (_, element) => {
      try {
        const text = $(element)
          .text()
          .trim();

        if (!text) {
          return;
        }

        const data = JSON.parse(text);

        if (Array.isArray(data)) {
          results.push(...data);
        } else if (data["@graph"]) {
          results.push(...data["@graph"]);
        } else {
          results.push(data);
        }
      } catch {
        // Ignore invalid JSON-LD
      }
    }
  );

  return results;
}

function findProductJsonLd(data) {
  for (const item of data) {
    if (!item) {
      continue;
    }

    const type = item["@type"];

    if (
      type === "Product" ||
      (
        Array.isArray(type) &&
        type.includes("Product")
      )
    ) {
      return item;
    }
  }

  return null;
}


// ======================================================
// URL FILTER
// ======================================================

function isCandidateProductUrl(url) {
  try {
    const parsed = new URL(url);

    if (
      parsed.hostname !==
      "www.toolsvilla.com"
    ) {
      return false;
    }

    const pathname =
      parsed.pathname
        .toLowerCase();

    // Homepage
    if (
      pathname === "/" ||
      pathname === ""
    ) {
      return false;
    }

    // --------------------------------------------------
    // CATEGORY PAGES
    // --------------------------------------------------

    if (
      pathname.startsWith("/category/")
    ) {
      return false;
    }

    // --------------------------------------------------
    // OTHER NON-PRODUCT PAGES
    // --------------------------------------------------

    const blockedPaths = [
      "/search",
      "/catalogsearch",
      "/checkout",
      "/cart",
      "/wishlist",
      "/login",
      "/register",
      "/account",
      "/customer",
      "/compare",
      "/contact",
      "/about",
      "/blog",
      "/blogs",
      "/faq",
      "/help",
      "/privacy",
      "/terms",
      "/return",
      "/refund",
      "/shipping",
      "/track",
      "/seller",
      "/vendor",
      "/brand"
    ];

    for (const blocked of blockedPaths) {
      if (
        pathname === blocked ||
        pathname.startsWith(
          blocked + "/"
        )
      ) {
        return false;
      }
    }

    // Files are not products
    const fileExtensions = [
      ".xml",
      ".json",
      ".jpg",
      ".jpeg",
      ".png",
      ".webp",
      ".gif",
      ".pdf",
      ".css",
      ".js"
    ];

    for (
      const extension of fileExtensions
    ) {
      if (
        pathname.endsWith(extension)
      ) {
        return false;
      }
    }

    return true;

  } catch {
    return false;
  }
}


// ======================================================
// BREADCRUMBS
// ======================================================

function extractBreadcrumbs($) {
  const breadcrumbs = [];

  $(
    '[itemtype*="BreadcrumbList"] [itemprop="name"], ' +
    ".breadcrumb li, " +
    ".breadcrumbs li"
  ).each((_, element) => {

    const text = cleanText(
      $(element).text()
    );

    if (
      text &&
      !breadcrumbs.includes(text)
    ) {
      breadcrumbs.push(text);
    }
  });

  return breadcrumbs;
}


// ======================================================
// SPECIFICATIONS
// ======================================================

function extractSpecifications($) {
  const specifications = {};

  // --------------------------------------------------
  // Tables
  // --------------------------------------------------

  $("table tr").each(
    (_, row) => {

      const cells = $(row)
        .find("th, td")
        .map((_, cell) =>
          cleanText(
            $(cell).text()
          )
        )
        .get()
        .filter(Boolean);

      if (
        cells.length >= 2
      ) {

        const key =
          cells[0];

        const value =
          cells
            .slice(1)
            .join(" ");

        if (
          key &&
          value
        ) {
          specifications[key] =
            value;
        }
      }
    }
  );

  // --------------------------------------------------
  // List based specifications
  // --------------------------------------------------

  $("li").each(
    (_, element) => {

      const text =
        cleanText(
          $(element).text()
        );

      if (!text) {
        return;
      }

      const colonIndex =
        text.indexOf(":");

      if (
        colonIndex <= 0
      ) {
        return;
      }

      const key =
        cleanText(
          text.substring(
            0,
            colonIndex
          )
        );

      const value =
        cleanText(
          text.substring(
            colonIndex + 1
          )
        );

      // Don't treat random page links
      // as specifications.
      if (
        key.length > 100 ||
        value.length > 500
      ) {
        return;
      }

      if (
        key &&
        value &&
        !specifications[key]
      ) {
        specifications[key] =
          value;
      }
    }
  );

  return specifications;
}


// ======================================================
// IMAGES
// ======================================================

function extractImages($, productJsonLd) {
  const images = [];

  // JSON-LD
  if (
    productJsonLd &&
    productJsonLd.image
  ) {

    if (
      Array.isArray(
        productJsonLd.image
      )
    ) {
      images.push(
        ...productJsonLd.image
      );
    } else {
      images.push(
        productJsonLd.image
      );
    }
  }

  // OpenGraph
  $('meta[property="og:image"]').each(
    (_, element) => {

      const image =
        $(element).attr(
          "content"
        );

      if (image) {
        images.push(image);
      }
    }
  );

  // IMG tags
  $("img").each(
    (_, element) => {

      const attributes = [
        "src",
        "data-src",
        "data-original",
        "data-lazy-src",
        "data-image",
        "data-zoom-image"
      ];

      for (
        const attribute of attributes
      ) {

        const value =
          $(element).attr(
            attribute
          );

        if (value) {
          images.push(value);
        }
      }
    }
  );

  return [
    ...new Set(
      images
        .filter(Boolean)
        .map(absoluteUrl)
        .filter(Boolean)
    )
  ];
}


// ======================================================
// PRODUCT PAGE DETECTION
// ======================================================

function detectProductPage(
  $,
  productJsonLd,
  url
) {

  // --------------------------------------------------
  // IMPORTANT:
  // Never accept category URLs.
  // --------------------------------------------------

  if (
    !isCandidateProductUrl(url)
  ) {
    return false;
  }

  // --------------------------------------------------
  // Product JSON-LD
  // --------------------------------------------------

  if (productJsonLd) {

    const type =
      productJsonLd["@type"];

    const isProduct =
      type === "Product" ||
      (
        Array.isArray(type) &&
        type.includes("Product")
      );

    if (
      isProduct &&
      cleanText(
        productJsonLd.name
      )
    ) {
      return true;
    }
  }

  // --------------------------------------------------
  // Fallback detection
  // --------------------------------------------------

  const bodyText =
    cleanText(
      $("body").text()
    );

  const lower =
    bodyText.toLowerCase();

  let score = 0;

  // Individual product pages usually have
  // these elements.

  if (
    $("h1").length
  ) {
    score += 1;
  }

  if (
    /\bSKU\s*:/i.test(
      bodyText
    )
  ) {
    score += 2;
  }

  if (
    /\bMRP\s*:/i.test(
      bodyText
    )
  ) {
    score += 2;
  }

  if (
    lower.includes(
      "add to cart"
    )
  ) {
    score += 2;
  }

  if (
    lower.includes(
      "buy now"
    )
  ) {
    score += 2;
  }

  if (
    lower.includes(
      "specifications"
    )
  ) {
    score += 2;
  }

  if (
    lower.includes(
      "description"
    )
  ) {
    score += 1;
  }

  // Need a strong combination.
  return score >= 7;
}


// ======================================================
// PRODUCT EXTRACTION
// ======================================================

function extractProduct(
  url,
  html
) {

  const $ =
    cheerio.load(html);

  const jsonLd =
    extractJsonLd($);

  const productJsonLd =
    findProductJsonLd(
      jsonLd
    );

  // --------------------------------------------------
  // Is this really a product?
  // --------------------------------------------------

  if (
    !detectProductPage(
      $,
      productJsonLd,
      url
    )
  ) {
    return null;
  }

  const product =
    productJsonLd || {};

  // --------------------------------------------------
  // NAME
  // --------------------------------------------------

  const name =
    cleanText(
      product.name
    ) ||
    cleanText(
      $("h1")
        .first()
        .text()
    ) ||
    cleanText(
      $('meta[property="og:title"]')
        .attr("content")
    ) ||
    cleanText(
      $("title").text()
    );

  if (!name) {
    return null;
  }

  // --------------------------------------------------
  // SKU
  // --------------------------------------------------

  let sku =
    cleanText(
      product.sku
    ) ||
    cleanText(
      product.mpn
    ) ||
    cleanText(
      $('[itemprop="sku"]')
        .attr("content")
    );

  if (!sku) {

    const bodyText =
      cleanText(
        $("body").text()
      );

    const match =
      bodyText.match(
        /\bSKU\s*:\s*([A-Za-z0-9._-]+)/i
      );

    if (match) {
      sku =
        cleanText(
          match[1]
        );
    }
  }

  // --------------------------------------------------
  // BRAND
  // --------------------------------------------------

  let brand = "";

  if (
    product.brand
  ) {

    if (
      typeof product.brand ===
      "string"
    ) {
      brand =
        cleanText(
          product.brand
        );
    } else {
      brand =
        cleanText(
          product.brand.name
        );
    }
  }

  if (!brand) {

    const bodyText =
      cleanText(
        $("body").text()
      );

    const match =
      bodyText.match(
        /\bBrand\s*:\s*(.+?)(?=\s+SKU\s*:|\s+MRP\s*:|$)/i
      );

    if (match) {
      brand =
        cleanText(
          match[1]
        );
    }
  }

  // --------------------------------------------------
  // OFFER
  // --------------------------------------------------

  let offer = null;

  if (
    Array.isArray(
      product.offers
    )
  ) {
    offer =
      product.offers[0] ||
      null;
  } else {
    offer =
      product.offers ||
      null;
  }

  // --------------------------------------------------
  // SELLING PRICE
  // --------------------------------------------------

  let sellingPrice = null;

  if (offer) {

    sellingPrice =
      getNumber(
        offer.price ||
        offer.lowPrice
      );
  }

  if (!sellingPrice) {

    const priceMeta =
      $('meta[itemprop="price"]')
        .attr("content");

    if (priceMeta) {
      sellingPrice =
        getNumber(
          priceMeta
        );
    }
  }

  // --------------------------------------------------
  // MRP
  // --------------------------------------------------

  let mrp = null;

  if (offer) {

    mrp =
      getNumber(
        offer.highPrice
      );
  }

  // Try common MRP elements
  if (!mrp) {

    const selectors = [
      '[class*="mrp"]',
      '[class*="MRP"]',
      '[class*="old-price"]',
      '[class*="regular-price"]'
    ];

    for (
      const selector of selectors
    ) {

      const value =
        $(selector)
          .first()
          .text();

      const number =
        getNumber(value);

      if (number) {
        mrp =
          number;
        break;
      }
    }
  }

  // --------------------------------------------------
  // FALLBACK PRICE FROM BODY
  // --------------------------------------------------

  if (
    !sellingPrice ||
    !mrp
  ) {

    const bodyText =
      cleanText(
        $("body").text()
      );

    const mrpMatch =
      bodyText.match(
        /MRP\s*:\s*₹?\s*([\d,]+(?:\.\d+)?)/i
      );

    if (
      mrpMatch &&
      !mrp
    ) {
      mrp =
        getNumber(
          mrpMatch[1]
        );
    }
  }

  // --------------------------------------------------
  // DISCOUNT
  // --------------------------------------------------

  let discount = null;

  if (
    mrp &&
    sellingPrice &&
    mrp > sellingPrice
  ) {

    discount =
      Number(
        (
          (
            (mrp - sellingPrice) /
            mrp
          ) *
          100
        ).toFixed(2)
      );
  }

  // --------------------------------------------------
  // DESCRIPTION
  // --------------------------------------------------

  const description =
    cleanText(
      product.description
    ) ||
    cleanText(
      $('meta[name="description"]')
        .attr("content")
    );

  // --------------------------------------------------
  // SHORT DESCRIPTION
  // --------------------------------------------------

  let shortDescription = "";

  const shortDescriptionElement =
    $(
      '[class*="short-description"], ' +
      '[class*="short_description"]'
    ).first();

  if (
    shortDescriptionElement.length
  ) {

    shortDescription =
      cleanText(
        shortDescriptionElement.text()
      );
  }

  // --------------------------------------------------
  // RATING
  // --------------------------------------------------

  let rating = null;
  let reviewCount = null;

  if (
    product.aggregateRating
  ) {

    rating =
      getNumber(
        product
          .aggregateRating
          .ratingValue
      );

    reviewCount =
      getNumber(
        product
          .aggregateRating
          .reviewCount ||
        product
          .aggregateRating
          .ratingCount
      );
  }

  // --------------------------------------------------
  // AVAILABILITY
  // --------------------------------------------------

  let availability = "";

  if (
    offer &&
    offer.availability
  ) {

    availability =
      String(
        offer.availability
      ).replace(
        "https://schema.org/",
        ""
      );
  }

  // --------------------------------------------------
  // BREADCRUMBS
  // --------------------------------------------------

  const breadcrumbs =
    extractBreadcrumbs($);

  let category = "";
  let subcategory = "";

  if (
    breadcrumbs.length >= 2
  ) {

    category =
      breadcrumbs[
        breadcrumbs.length - 2
      ];
  }

  if (
    breadcrumbs.length >= 3
  ) {

    subcategory =
      breadcrumbs[
        breadcrumbs.length - 3
      ];
  }

  // --------------------------------------------------
  // SPECIFICATIONS
  // --------------------------------------------------

  const specifications =
    extractSpecifications($);

  // --------------------------------------------------
  // IMAGES
  // --------------------------------------------------

  const images =
    extractImages(
      $,
      product
    );

  // --------------------------------------------------
  // PRODUCT ID
  // --------------------------------------------------

  const productId =
    cleanText(
      product.productID
    ) ||
    cleanText(
      $(
        '[itemprop="productID"]'
      ).attr("content")
    );

  // --------------------------------------------------
  // FINAL PRODUCT
  // --------------------------------------------------

  return {

    url,

    product_id:
      productId,

    sku,

    name,

    brand,

    category,

    subcategory,

    breadcrumbs,

    mrp,

    selling_price:
      sellingPrice,

    discount_percentage:
      discount,

    currency:
      offer?.priceCurrency ||
      "INR",

    availability,

    rating,

    review_count:
      reviewCount,

    short_description:
      shortDescription,

    description,

    specifications,

    images,

    scraped_at:
      new Date().toISOString()
  };
}


// ======================================================
// MAIN
// ======================================================

async function main() {

  console.log("");
  console.log(
    "======================================"
  );
  console.log(
    " TOOLSVILLA - PRODUCT TEST"
  );
  console.log(
    "======================================"
  );
  console.log("");

  console.log(
    `Target products: ${TARGET_PRODUCTS}`
  );

  console.log("");

  const browser =
    await chromium.launch({
      headless: true
    });

  const page =
    await browser.newPage({

      viewport: {
        width: 1440,
        height: 900
      },

      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/151 Safari/537.36"
    });

  try {

    // ==================================================
    // DOWNLOAD SITEMAP
    // ==================================================

    console.log(
      "Reading sitemap..."
    );

    const sitemapResponse =
      await page.request.get(
        SITEMAP_URL
      );

    if (
      !sitemapResponse.ok()
    ) {

      throw new Error(
        `Sitemap returned HTTP ${sitemapResponse.status()}`
      );
    }

    const xml =
      await sitemapResponse.text();

    const $xml =
      cheerio.load(
        xml,
        {
          xmlMode: true
        }
      );

    let urls = [];

    $xml("url loc").each(
      (_, element) => {

        const url =
          cleanText(
            $xml(element).text()
          );

        if (url) {
          urls.push(url);
        }
      }
    );

    urls = [
      ...new Set(urls)
    ];

    console.log(
      `Found ${urls.length} URLs in sitemap.`
    );

    // ==================================================
    // FILTER URLs
    // ==================================================

    const originalCount =
      urls.length;

    urls =
      urls.filter(
        isCandidateProductUrl
      );

    console.log(
      `URLs after filtering: ${urls.length}`
    );

    console.log(
      `Filtered out: ${
        originalCount -
        urls.length
      }`
    );

    console.log("");

    console.log(
      "Searching for genuine product pages..."
    );

    console.log("");

    // ==================================================
    // SCRAPE
    // ==================================================

    const products = [];

    let checked = 0;

    for (
      let i = 0;
      i < urls.length &&
      products.length < TARGET_PRODUCTS;
      i++
    ) {

      const url =
        urls[i];

      checked++;

      console.log(
        `[Checked ${checked}] Products found: ${products.length}/${TARGET_PRODUCTS}`
      );

      console.log(
        `  ${url}`
      );

      try {

        const response =
          await page.goto(
            url,
            {
              waitUntil:
                "domcontentloaded",

              timeout: 30000
            }
          );

        if (!response) {

          console.log(
            "  -> No response"
          );

          continue;
        }

        if (
          !response.ok()
        ) {

          console.log(
            `  -> HTTP ${response.status()}`
          );

          continue;
        }

        // Allow JavaScript to finish
        await page.waitForTimeout(
          1000
        );

        const html =
          await page.content();

        const product =
          extractProduct(
            url,
            html
          );

        // ----------------------------------------------
        // NOT PRODUCT
        // ----------------------------------------------

        if (!product) {

          console.log(
            "  -> Not a product page"
          );

          await sleep(
            DELAY_MS
          );

          continue;
        }

        // ----------------------------------------------
        // PRODUCT FOUND
        // ----------------------------------------------

        products.push(
          product
        );

        console.log(
          "  -> ✅ PRODUCT FOUND"
        );

        console.log(
          `     Name: ${
            product.name
          }`
        );

        console.log(
          `     SKU: ${
            product.sku ||
            "N/A"
          }`
        );

        console.log(
          `     Brand: ${
            product.brand ||
            "N/A"
          }`
        );

        console.log(
          `     MRP: ${
            product.mrp ??
            "N/A"
          }`
        );

        console.log(
          `     Selling Price: ${
            product.selling_price ??
            "N/A"
          }`
        );

        console.log(
          `     Images: ${
            product.images.length
          }`
        );

        console.log("");

        // ----------------------------------------------
        // SAVE PROGRESS
        // ----------------------------------------------

        fs.writeFileSync(
          JSON_FILE,
          JSON.stringify(
            products,
            null,
            2
          ),
          "utf8"
        );

        saveCSV(
          products
        );

        await sleep(
          DELAY_MS
        );

      } catch (error) {

        console.log(
          `  -> ERROR: ${error.message}`
        );

        await sleep(
          DELAY_MS
        );
      }
    }

    // ==================================================
    // FINAL SAVE
    // ==================================================

    fs.writeFileSync(
      JSON_FILE,
      JSON.stringify(
        products,
        null,
        2
      ),
      "utf8"
    );

    saveCSV(
      products
    );

    // ==================================================
    // SUMMARY
    // ==================================================

    console.log("");

    console.log(
      "======================================"
    );

    console.log(
      " TEST FINISHED"
    );

    console.log(
      "======================================"
    );

    console.log(
      `URLs checked: ${checked}`
    );

    console.log(
      `Products found: ${products.length}`
    );

    console.log(
      `JSON file: ${JSON_FILE}`
    );

    console.log(
      `CSV file: ${CSV_FILE}`
    );

    console.log("");

    if (
      products.length ===
      TARGET_PRODUCTS
    ) {

      console.log(
        `✅ Successfully found ${products.length} products.`
      );

    } else {

      console.log(
        `⚠️ Only found ${products.length} products out of ${TARGET_PRODUCTS}.`
      );

      console.log(
        "We should inspect the results before increasing the limit."
      );
    }

    console.log("");

  } finally {

    await browser.close();
  }
}


// ======================================================
// START
// ======================================================

main().catch(
  (error) => {

    console.error("");

    console.error(
      "SCRAPER FAILED"
    );

    console.error(
      error
    );

    process.exit(1);
  }
);