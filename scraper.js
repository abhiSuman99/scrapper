const { chromium } = require("playwright");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

// ============================================================
// CONFIG
// ============================================================

const BASE_URL = "https://www.toolsvilla.com";

// Start with the site's sitemap index.
// The crawler will recursively discover child sitemaps.
const SITEMAP_URL = `${BASE_URL}/sitemap/sitemap.xml`;

// Set to Infinity for the complete authorized catalog.
const TARGET_PRODUCTS = Infinity;

// Number of pages processed simultaneously.
// Start with 5. Increase only after testing.
const CONCURRENCY = 5;

// Request timeout.
const PAGE_TIMEOUT = 30_000;

// Delay between retries/pages.
const DELAY_MS = 800;

// Number of retries for failed requests.
const MAX_RETRIES = 3;

// Save progress every N products.
const SAVE_EVERY = 25;

// Output directory.
const OUTPUT_DIR = path.join(
  process.cwd(),
  "output"
);

const JSON_FILE = path.join(
  OUTPUT_DIR,
  "products.json"
);

const CSV_FILE = path.join(
  OUTPUT_DIR,
  "products.csv"
);

const FAILED_FILE = path.join(
  OUTPUT_DIR,
  "failed_urls.json"
);

const PROGRESS_FILE = path.join(
  OUTPUT_DIR,
  "progress.json"
);

// ============================================================
// USER AGENT
// ============================================================

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/151.0.0.0 Safari/537.36";

// ============================================================
// STATE
// ============================================================

let products = [];
let failedUrls = [];
let processedUrls = new Set();
let productUrls = [];

let shuttingDown = false;

// ============================================================
// FILE SYSTEM
// ============================================================

function ensureOutputDirectory() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, {
      recursive: true
    });
  }
}

// ============================================================
// HELPERS
// ============================================================

function sleep(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}

function cleanText(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return "";
  }

  return String(value)
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(
      url,
      BASE_URL
    );

    parsed.hash = "";

    return parsed.href;
  } catch {
    return "";
  }
}

function absoluteUrl(url) {
  if (!url) {
    return "";
  }

  try {
    return new URL(
      url,
      BASE_URL
    ).href;
  } catch {
    return "";
  }
}

function getNumber(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const cleaned = String(value)
    .replace(/,/g, "")
    .replace(/[^\d.-]/g, "");

  if (!cleaned) {
    return null;
  }

  const number = Number(
    parseFloat(cleaned)
  );

  return Number.isFinite(number)
    ? number
    : null;
}

function uniqueArray(array) {
  return [
    ...new Set(
      array
        .filter(Boolean)
        .map(item =>
          cleanText(item)
        )
        .filter(Boolean)
    )
  ];
}

// ============================================================
// OUTPUT
// ============================================================

function saveJSON() {
  fs.writeFileSync(
    JSON_FILE,
    JSON.stringify(
      products,
      null,
      2
    ),
    "utf8"
  );
}

function saveFailedUrls() {
  fs.writeFileSync(
    FAILED_FILE,
    JSON.stringify(
      failedUrls,
      null,
      2
    ),
    "utf8"
  );
}

function saveProgress() {
  fs.writeFileSync(
    PROGRESS_FILE,
    JSON.stringify(
      {
        updated_at:
          new Date().toISOString(),

        product_count:
          products.length,

        processed_url_count:
          processedUrls.size,

        failed_url_count:
          failedUrls.length,

        product_url_count:
          productUrls.length
      },
      null,
      2
    ),
    "utf8"
  );
}

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

  if (
    typeof output === "object"
  ) {
    output =
      JSON.stringify(output);
  }

  output = String(output);

  return `"${output.replace(
    /"/g,
    '""'
  )}"`;
}

function saveCSV() {
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

  const lines = [
    headers
      .map(csvEscape)
      .join(",")
  ];

  for (
    const product of products
  ) {
    lines.push(
      headers
        .map(header =>
          csvEscape(
            product[header]
          )
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

function saveAll() {
  console.log(
    "\n💾 Saving checkpoint..."
  );

  saveJSON();
  saveCSV();
  saveFailedUrls();
  saveProgress();

  console.log(
    `   Products: ${products.length}`
  );
}

// ============================================================
// RESUME
// ============================================================

function loadPreviousProgress() {
  if (
    !fs.existsSync(JSON_FILE)
  ) {
    return;
  }

  try {
    const data =
      JSON.parse(
        fs.readFileSync(
          JSON_FILE,
          "utf8"
        )
      );

    if (
      Array.isArray(data)
    ) {
      products = data;

      for (
        const product of products
      ) {
        if (
          product.url
        ) {
          processedUrls.add(
            normalizeUrl(
              product.url
            )
          );
        }
      }

      console.log(
        `♻️ Resumed ${products.length} previously saved products.`
      );
    }
  } catch (error) {
    console.log(
      "⚠️ Could not load previous products.json:",
      error.message
    );
  }

  if (
    fs.existsSync(
      FAILED_FILE
    )
  ) {
    try {
      failedUrls =
        JSON.parse(
          fs.readFileSync(
            FAILED_FILE,
            "utf8"
          )
        );

      if (
        !Array.isArray(
          failedUrls
        )
      ) {
        failedUrls = [];
      }
    } catch {
      failedUrls = [];
    }
  }
}

// ============================================================
// URL FILTER
// ============================================================

function isCandidateProductUrl(url) {
  try {
    const parsed =
      new URL(url);

    if (
      parsed.hostname !==
      "www.toolsvilla.com"
    ) {
      return false;
    }

    const pathname =
      parsed.pathname
        .toLowerCase()
        .replace(/\/+$/, "");

    if (
      !pathname ||
      pathname === ""
    ) {
      return false;
    }

    // Obvious non-product pages.
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
      "/brand",
      "/brands"
    ];

    for (
      const blocked of blockedPaths
    ) {
      if (
        pathname === blocked ||
        pathname.startsWith(
          `${blocked}/`
        )
      ) {
        return false;
      }
    }

    // Common non-product file extensions.
    const extensions = [
      ".xml",
      ".json",
      ".jpg",
      ".jpeg",
      ".png",
      ".webp",
      ".gif",
      ".svg",
      ".pdf",
      ".css",
      ".js",
      ".txt"
    ];

    for (
      const extension of extensions
    ) {
      if (
        pathname.endsWith(
          extension
        )
      ) {
        return false;
      }
    }

    return true;

  } catch {
    return false;
  }
}

// ============================================================
// SITEMAP
// ============================================================

function extractSitemapUrls(xml) {
  const $ =
    cheerio.load(
      xml,
      {
        xmlMode: true
      }
    );

  const urls = [];

  $("loc").each(
    (_, element) => {
      const url =
        cleanText(
          $(element).text()
        );

      if (url) {
        urls.push(
          normalizeUrl(url)
        );
      }
    }
  );

  return uniqueArray(
    urls
  );
}

async function fetchText(
  request,
  url
) {
  for (
    let attempt = 1;
    attempt <= MAX_RETRIES;
    attempt++
  ) {
    try {
      const response =
        await request.get(
          url,
          {
            timeout:
              PAGE_TIMEOUT
          }
        );

      if (
        response.ok()
      ) {
        return await response.text();
      }

      console.log(
        `⚠️ Sitemap HTTP ${response.status()} - ${url}`
      );

    } catch (error) {

      console.log(
        `⚠️ Sitemap attempt ${attempt}/${MAX_RETRIES} failed: ${url}`
      );

      if (
        attempt ===
        MAX_RETRIES
      ) {
        throw error;
      }
    }

    await sleep(
      DELAY_MS *
        attempt
    );
  }

  return "";
}

async function discoverSitemaps(
  request,
  sitemapUrl,
  visited = new Set()
) {
  sitemapUrl =
    normalizeUrl(
      sitemapUrl
    );

  if (
    visited.has(
      sitemapUrl
    )
  ) {
    return [];
  }

  visited.add(
    sitemapUrl
  );

  console.log(
    `🗺️ Reading sitemap: ${sitemapUrl}`
  );

  const xml =
    await fetchText(
      request,
      sitemapUrl
    );

  if (!xml) {
    return [];
  }

  const $ =
    cheerio.load(
      xml,
      {
        xmlMode: true
      }
    );

  const result = [];

  // ----------------------------------------------------------
  // Sitemap index
  // ----------------------------------------------------------

  const childSitemaps = [];

  $("sitemap loc").each(
    (_, element) => {
      const child =
        normalizeUrl(
          $(element).text()
        );

      if (child) {
        childSitemaps.push(
          child
        );
      }
    }
  );

  if (
    childSitemaps.length
  ) {
    for (
      const child of childSitemaps
    ) {
      const urls =
        await discoverSitemaps(
          request,
          child,
          visited
        );

      result.push(
        ...urls
      );
    }

    return uniqueArray(
      result
    );
  }

  // ----------------------------------------------------------
  // Normal URL sitemap
  // ----------------------------------------------------------

  const urls =
    extractSitemapUrls(
      xml
    );

  result.push(
    ...urls
  );

  return uniqueArray(
    result
  );
}

// ============================================================
// JSON-LD
// ============================================================

function extractJsonLd($) {
  const results = [];

  $(
    'script[type="application/ld+json"]'
  ).each(
    (_, element) => {

      try {

        const text =
          $(element)
            .text()
            .trim();

        if (!text) {
          return;
        }

        const data =
          JSON.parse(text);

        if (
          Array.isArray(
            data
          )
        ) {
          results.push(
            ...data
          );

        } else if (
          data &&
          Array.isArray(
            data["@graph"]
          )
        ) {
          results.push(
            ...data["@graph"]
          );

        } else {
          results.push(
            data
          );
        }

      } catch {
        // Ignore malformed JSON-LD.
      }
    }
  );

  return results;
}

function findProductJsonLd(
  data
) {
  for (
    const item of data
  ) {

    if (!item) {
      continue;
    }

    const type =
      item["@type"];

    if (
      type === "Product"
    ) {
      return item;
    }

    if (
      Array.isArray(type) &&
      type.includes("Product")
    ) {
      return item;
    }
  }

  return null;
}

// ============================================================
// BREADCRUMBS
// ============================================================

function extractBreadcrumbs($) {
  const result = [];

  // Schema breadcrumb.
  $(
    '[itemtype*="BreadcrumbList"] [itemprop="name"]'
  ).each(
    (_, element) => {

      const value =
        cleanText(
          $(element).text()
        );

      if (value) {
        result.push(
          value
        );
      }
    }
  );

  // Common breadcrumb selectors.
  if (
    result.length === 0
  ) {

    $(
      ".breadcrumb li, " +
      ".breadcrumbs li, " +
      "nav.breadcrumb li"
    ).each(
      (_, element) => {

        const value =
          cleanText(
            $(element).text()
          );

        if (value) {
          result.push(
            value
          );
        }
      }
    );
  }

  return uniqueArray(
    result
  );
}

// ============================================================
// SPECIFICATIONS
// ============================================================

function extractSpecifications($) {
  const specifications = {};

  // ----------------------------------------------------------
  // Tables
  // ----------------------------------------------------------

  $("table tr").each(
    (_, row) => {

      const cells =
        $(row)
          .find("th, td")
          .map(
            (_, cell) =>
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
          value &&
          key.length <= 150 &&
          value.length <= 1000
        ) {

          if (
            !specifications[key]
          ) {
            specifications[key] =
              value;
          }
        }
      }
    }
  );

  // ----------------------------------------------------------
  // Definition lists
  // ----------------------------------------------------------

  $("dl").each(
    (_, dl) => {

      const terms =
        $(dl)
          .find("dt")
          .toArray();

      for (
        const dt of terms
      ) {

        const key =
          cleanText(
            $(dt).text()
          );

        const dd =
          $(dt)
            .next("dd");

        const value =
          cleanText(
            dd.text()
          );

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

  // ----------------------------------------------------------
  // Only inspect list items that
  // look like key/value pairs.
  // ----------------------------------------------------------

  $("li").each(
    (_, element) => {

      const text =
        cleanText(
          $(element).text()
        );

      if (
        !text ||
        text.length > 600
      ) {
        return;
      }

      const colonIndex =
        text.indexOf(":");

      if (
        colonIndex <= 0 ||
        colonIndex > 120
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

      if (
        key &&
        value &&
        key.length <= 100 &&
        value.length <= 500 &&
        !specifications[key]
      ) {
        specifications[key] =
          value;
      }
    }
  );

  return specifications;
}

// ============================================================
// IMAGES
// ============================================================

function extractImages(
  $,
  productJsonLd
) {
  const images = [];

  // ----------------------------------------------------------
  // JSON-LD
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // OpenGraph
  // ----------------------------------------------------------

  $('meta[property="og:image"]').each(
    (_, element) => {

      const image =
        $(element).attr(
          "content"
        );

      if (image) {
        images.push(
          image
        );
      }
    }
  );

  // ----------------------------------------------------------
  // Product gallery only
  // ----------------------------------------------------------

  const gallerySelectors = [
    '[class*="product-gallery"] img',
    '[class*="product-image"] img',
    '[class*="product-images"] img',
    '[class*="product_photo"] img',
    '[class*="gallery"] img'
  ];

  for (
    const selector of gallerySelectors
  ) {

    $(selector).each(
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
            images.push(
              value
            );
          }
        }
      }
    );
  }

  return uniqueArray(
    images
      .map(
        absoluteUrl
      )
      .filter(Boolean)
  );
}

// ============================================================
// PRICE HELPERS
// ============================================================

function extractBodyPrice(
  bodyText,
  patterns
) {
  for (
    const pattern of patterns
  ) {

    const match =
      bodyText.match(
        pattern
      );

    if (
      match &&
      match[1]
    ) {
      const value =
        getNumber(
          match[1]
        );

      if (
        value !== null
      ) {
        return value;
      }
    }
  }

  return null;
}

// ============================================================
// PRODUCT DETECTION
// ============================================================

function detectProductPage(
  $,
  productJsonLd
) {
  if (
    productJsonLd &&
    cleanText(
      productJsonLd.name
    )
  ) {
    return true;
  }

  const bodyText =
    cleanText(
      $("body").text()
    );

  const lower =
    bodyText.toLowerCase();

  let score = 0;

  if (
    $("h1").length
  ) {
    score += 1;
  }

  if (
    /\bsku\s*:/i.test(
      bodyText
    )
  ) {
    score += 2;
  }

  if (
    /\bmrp\s*:/i.test(
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

  return score >= 5;
}

// ============================================================
// PRODUCT EXTRACTION
// ============================================================

function extractProduct(
  url,
  html
) {
  const $ =
    cheerio.load(
      html
    );

  const jsonLd =
    extractJsonLd(
      $
    );

  const productJsonLd =
    findProductJsonLd(
      jsonLd
    );

  if (
    !detectProductPage(
      $,
      productJsonLd
    )
  ) {
    return null;
  }

  const product =
    productJsonLd || {};

  const bodyText =
    cleanText(
      $("body").text()
    );

  // ----------------------------------------------------------
  // NAME
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // SKU
  // ----------------------------------------------------------

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

    const match =
      bodyText.match(
        /\bSKU\s*[:#-]?\s*([A-Za-z0-9._/-]+)/i
      );

    if (match) {
      sku =
        cleanText(
          match[1]
        );
    }
  }

  // ----------------------------------------------------------
  // BRAND
  // ----------------------------------------------------------

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

    const brandMatch =
      bodyText.match(
        /\bBrand\s*:\s*(.+?)(?=\s+(?:SKU|MRP|Price)\s*:|$)/i
      );

    if (
      brandMatch
    ) {
      brand =
        cleanText(
          brandMatch[1]
        );
    }
  }

  // ----------------------------------------------------------
  // OFFERS
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // SELLING PRICE
  // ----------------------------------------------------------

  let sellingPrice =
    getNumber(
      offer?.price
    );

  if (
    sellingPrice === null
  ) {

    sellingPrice =
      getNumber(
        $('meta[itemprop="price"]')
          .attr("content")
      );
  }

  if (
    sellingPrice === null
  ) {

    sellingPrice =
      extractBodyPrice(
        bodyText,
        [
          /(?:Selling\s*Price|Sale\s*Price|Offer\s*Price)\s*[:\-]?\s*₹?\s*([\d,]+(?:\.\d+)?)/i,
          /(?:Price)\s*[:\-]?\s*₹?\s*([\d,]+(?:\.\d+)?)/i
        ]
      );
  }

  // ----------------------------------------------------------
  // MRP
  // ----------------------------------------------------------

  let mrp = null;

  const mrpSelectors = [
    '[class*="mrp"]',
    '[class*="MRP"]',
    '[class*="old-price"]',
    '[class*="old_price"]',
    '[class*="regular-price"]',
    '[class*="regular_price"]'
  ];

  for (
    const selector of mrpSelectors
  ) {

    const value =
      $(selector)
        .first()
        .text();

    const number =
      getNumber(
        value
      );

    if (
      number !== null
    ) {
      mrp =
        number;
      break;
    }
  }

  if (
    mrp === null
  ) {

    mrp =
      extractBodyPrice(
        bodyText,
        [
          /MRP\s*[:\-]?\s*₹?\s*([\d,]+(?:\.\d+)?)/i,
          /Maximum\s*Retail\s*Price\s*[:\-]?\s*₹?\s*([\d,]+(?:\.\d+)?)/i
        ]
      );
  }

  // ----------------------------------------------------------
  // JSON-LD price range fallback
  // ----------------------------------------------------------

  if (
    mrp === null &&
    offer
  ) {

    const high =
      getNumber(
        offer.highPrice
      );

    const low =
      getNumber(
        offer.lowPrice
      );

    // Only use highPrice as MRP when it
    // represents a range and differs from
    // the actual selling price.
    if (
      high !== null &&
      sellingPrice !== null &&
      high > sellingPrice
    ) {
      mrp =
        high;
    } else if (
      low !== null &&
      sellingPrice !== null &&
      low > sellingPrice
    ) {
      mrp =
        low;
    }
  }

  // ----------------------------------------------------------
  // DISCOUNT
  // ----------------------------------------------------------

  let discount = null;

  if (
    mrp !== null &&
    sellingPrice !== null &&
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

  // ----------------------------------------------------------
  // DESCRIPTION
  // ----------------------------------------------------------

  const description =
    cleanText(
      product.description
    ) ||
    cleanText(
      $(
        '[class*="description"]'
      )
        .first()
        .text()
    ) ||
    cleanText(
      $('meta[name="description"]')
        .attr("content")
    );

  // ----------------------------------------------------------
  // SHORT DESCRIPTION
  // ----------------------------------------------------------

  const shortDescription =
    cleanText(
      $(
        '[class*="short-description"], ' +
        '[class*="short_description"]'
      )
        .first()
        .text()
    );

  // ----------------------------------------------------------
  // RATING
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // AVAILABILITY
  // ----------------------------------------------------------

  let availability = "";

  if (
    offer?.availability
  ) {

    availability =
      String(
        offer.availability
      ).replace(
        "https://schema.org/",
        ""
      );
  }

  if (!availability) {

    const lower =
      bodyText.toLowerCase();

    if (
      lower.includes(
        "out of stock"
      )
    ) {
      availability =
        "OutOfStock";
    } else if (
      lower.includes(
        "in stock"
      )
    ) {
      availability =
        "InStock";
    }
  }

  // ----------------------------------------------------------
  // BREADCRUMBS
  // ----------------------------------------------------------

  const breadcrumbs =
    extractBreadcrumbs(
      $
    );

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

  // ----------------------------------------------------------
  // SPECIFICATIONS
  // ----------------------------------------------------------

  const specifications =
    extractSpecifications(
      $
    );

  // ----------------------------------------------------------
  // IMAGES
  // ----------------------------------------------------------

  const images =
    extractImages(
      $,
      product
    );

  // ----------------------------------------------------------
  // PRODUCT ID
  // ----------------------------------------------------------

  const productId =
    cleanText(
      product.productID
    ) ||
    cleanText(
      product.productId
    ) ||
    cleanText(
      $(
        '[itemprop="productID"]'
      )
        .attr("content")
    );

  // ----------------------------------------------------------
  // FINAL
  // ----------------------------------------------------------

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

// ============================================================
// REQUEST RETRY
// ============================================================

async function fetchPage(
  page,
  url
) {
  for (
    let attempt = 1;
    attempt <= MAX_RETRIES;
    attempt++
  ) {

    try {

      const response =
        await page.goto(
          url,
          {
            waitUntil:
              "domcontentloaded",
            timeout:
              PAGE_TIMEOUT
          }
        );

      if (!response) {
        throw new Error(
          "No response"
        );
      }

      const status =
        response.status();

      if (
        status >= 400
      ) {

        throw new Error(
          `HTTP ${status}`
        );
      }

      // Give client-side rendering
      // a short opportunity to finish.
      await page.waitForTimeout(
        500
      );

      return await page.content();

    } catch (error) {

      console.log(
        `   ⚠️ Attempt ${attempt}/${MAX_RETRIES}: ${error.message}`
      );

      if (
        attempt ===
        MAX_RETRIES
      ) {
        throw error;
      }

      await sleep(
        DELAY_MS *
          Math.pow(
            2,
            attempt - 1
          )
      );
    }
  }

  throw new Error(
    "Failed to fetch page"
  );
}

// ============================================================
// WORKER
// ============================================================

async function scrapeUrl(
  context,
  url,
  workerId
) {
  if (
    processedUrls.has(
      url
    )
  ) {
    return null;
  }

  const page =
    await context.newPage();

  try {

    console.log(
      `[Worker ${workerId}] ${url}`
    );

    const html =
      await fetchPage(
        page,
        url
      );

    const product =
      extractProduct(
        url,
        html
      );

    processedUrls.add(
      url
    );

    if (!product) {

      console.log(
        `[Worker ${workerId}] ❌ Not product`
      );

      return null;
    }

    console.log(
      `[Worker ${workerId}] ✅ ${product.name}`
    );

    return product;

  } finally {

    await page.close();
  }
}

// ============================================================
// CONCURRENT CRAWLER
// ============================================================

async function crawlProducts(
  context
) {
  let cursor = 0;

  let lastSaveCount =
    products.length;

  async function worker(
    workerId
  ) {

    while (
      !shuttingDown
    ) {

      if (
        products.length >=
        TARGET_PRODUCTS
      ) {
        return;
      }

      const index =
        cursor++;

      if (
        index >=
        productUrls.length
      ) {
        return;
      }

      const url =
        productUrls[index];

      if (
        processedUrls.has(
          url
        )
      ) {
        continue;
      }

      try {

        const product =
          await scrapeUrl(
            context,
            url,
            workerId
          );

        if (
          product
        ) {

          // Deduplicate using URL.
          const exists =
            products.some(
              item =>
                item.url ===
                product.url
            );

          if (!exists) {
            products.push(
              product
            );
          }

          if (
            products.length -
              lastSaveCount >=
            SAVE_EVERY
          ) {

            lastSaveCount =
              products.length;

            saveAll();
          }
        }

      } catch (error) {

        console.log(
          `[Worker ${workerId}] ❌ FAILED: ${url}`
        );

        failedUrls.push({
          url,
          error:
            error.message,
          failed_at:
            new Date().toISOString()
        });
      }

      await sleep(
        DELAY_MS
      );
    }
  }

  const workers = [];

  const workerCount =
    Math.min(
      CONCURRENCY,
      productUrls.length
    );

  for (
    let i = 1;
    i <= workerCount;
    i++
  ) {
    workers.push(
      worker(i)
    );
  }

  await Promise.all(
    workers
  );
}

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

function setupShutdown() {
  const shutdown =
    signal => {

      if (
        shuttingDown
      ) {
        return;
      }

      shuttingDown = true;

      console.log(
        `\n\n🛑 Received ${signal}.`
      );

      console.log(
        "Saving current progress..."
      );

      saveAll();

      console.log(
        "Progress saved safely."
      );
    };

  process.on(
    "SIGINT",
    shutdown
  );

  process.on(
    "SIGTERM",
    shutdown
  );
}

// ============================================================
// MAIN
// ============================================================

async function main() {

  ensureOutputDirectory();

  setupShutdown();

  loadPreviousProgress();

  console.log("");
  console.log(
    "=================================================="
  );
  console.log(
    " TOOLSVILLA FULL PRODUCT CRAWLER"
  );
  console.log(
    "=================================================="
  );
  console.log("");

  console.log(
    `Target products : ${
      TARGET_PRODUCTS === Infinity
        ? "ALL"
        : TARGET_PRODUCTS
    }`
  );

  console.log(
    `Concurrency     : ${CONCURRENCY}`
  );

  console.log(
    `Delay           : ${DELAY_MS}ms`
  );

  console.log(
    `Output          : ${OUTPUT_DIR}`
  );

  console.log("");

  const browser =
    await chromium.launch({
      headless: true
    });

  const context =
    await browser.newContext({

      viewport: {
        width: 1440,
        height: 900
      },

      userAgent:
        USER_AGENT,

      locale:
        "en-IN",

      timezoneId:
        "Asia/Kolkata"
    });

  try {

    // ========================================================
    // SITEMAP
    // ========================================================

    console.log(
      "🔎 Discovering sitemap URLs..."
    );

    const request =
      await context.request;

    const allSitemapUrls =
      await discoverSitemaps(
        request,
        SITEMAP_URL
      );

    console.log("");
    console.log(
      `🗺️ URLs discovered from sitemap(s): ${
        allSitemapUrls.length
      }`
    );

    // ========================================================
    // PRODUCT URL FILTER
    // ========================================================

    productUrls =
      uniqueArray(
        allSitemapUrls
          .filter(
            isCandidateProductUrl
          )
          .map(
            normalizeUrl
          )
      );

    console.log(
      `🛒 Candidate URLs: ${
        productUrls.length
      }`
    );

    // ========================================================
    // LIMIT
    // ========================================================

    if (
      TARGET_PRODUCTS !== Infinity
    ) {

      productUrls =
        productUrls.slice(
          0,
          TARGET_PRODUCTS
        );
    }

    console.log(
      `🚀 URLs queued: ${
        productUrls.length
      }`
    );

    // ========================================================
    // REMOVE ALREADY PROCESSED
    // ========================================================

    const remaining =
      productUrls.filter(
        url =>
          !processedUrls.has(
            url
          )
      );

    console.log(
      `♻️ Already processed: ${
        productUrls.length -
        remaining.length
      }`
    );

    console.log(
      `📋 Remaining: ${
        remaining.length
      }`
    );

    productUrls =
      remaining;

    console.log("");

    // ========================================================
    // CRAWL
    // ========================================================

    await crawlProducts(
      context
    );

    // ========================================================
    // FINAL SAVE
    // ========================================================

    saveAll();

    console.log("");
    console.log(
      "=================================================="
    );
    console.log(
      " CRAWL FINISHED"
    );
    console.log(
      "=================================================="
    );

    console.log(
      `Products found : ${products.length}`
    );

    console.log(
      `URLs processed  : ${processedUrls.size}`
    );

    console.log(
      `Failed URLs     : ${failedUrls.length}`
    );

    console.log("");
    console.log(
      `JSON: ${JSON_FILE}`
    );

    console.log(
      `CSV : ${CSV_FILE}`
    );

    console.log(
      `Failed: ${FAILED_FILE}`
    );

    console.log("");

  } finally {

    await browser.close();
  }
}

// ============================================================
// START
// ============================================================

main()
  .catch(error => {

    console.error("");
    console.error(
      "=================================================="
    );
    console.error(
      " SCRAPER FAILED"
    );
    console.error(
      "=================================================="
    );

    console.error(
      error
    );

    // Always attempt to preserve
    // whatever has already been collected.
    try {
      ensureOutputDirectory();
      saveAll();
    } catch {
      // Ignore save failure.
    }

    process.exit(1);
  });
