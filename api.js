const PLATFORM_DOMAINS = {
  yt: [
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "youtu.be"
  ],
  ig: [
    "instagram.com",
    "www.instagram.com"
  ],
  tt: [
    "tiktok.com",
    "www.tiktok.com",
    "m.tiktok.com"
  ],
  fb: [
    "facebook.com",
    "www.facebook.com",
    "m.facebook.com",
    "fb.watch"
  ]
};

const PLATFORM_NAMES = {
  yt: "youtube",
  ig: "instagram",
  tt: "tiktok",
  fb: "facebook"
};

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "public, max-age=60",
  "X-Content-Type-Options": "nosniff"
};

const MAX_HTML_SIZE = 1_000_000;
const FETCH_TIMEOUT = 10000;
const MAX_REDIRECTS = 3;

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: JSON_HEADERS
  });
}

function errorResponse(code, message, status = 400) {
  return json({
    success: false,
    error: {
      code,
      message
    }
  }, status);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeEntities(value) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return code <= 0x10ffff
        ? String.fromCodePoint(code)
        : _;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      const code = parseInt(n, 16);
      return code <= 0x10ffff
        ? String.fromCodePoint(code)
        : _;
    });
}

/*
 * Extract metadata from HTML.
 * Supports different attribute orders and quote styles.
 */
function getMeta(html, property) {
  const key = escapeRegex(property);

  const patterns = [
    new RegExp(
      `<meta\\b(?=[^>]*\\bproperty\\s*=\\s*["']${key}["'])` +
      `(?=[^>]*\\bcontent\\s*=\\s*["']([^"']*)["'])[^>]*>`,
      "i"
    ),
    new RegExp(
      `<meta\\b(?=[^>]*\\bname\\s*=\\s*["']${key}["'])` +
      `(?=[^>]*\\bcontent\\s*=\\s*["']([^"']*)["'])[^>]*>`,
      "i"
    ),
    new RegExp(
      `<meta\\b(?=[^>]*\\bcontent\\s*=\\s*["']([^"']*)["'])` +
      `(?=[^>]*\\bproperty\\s*=\\s*["']${key}["'])[^>]*>`,
      "i"
    ),
    new RegExp(
      `<meta\\b(?=[^>]*\\bcontent\\s*=\\s*["']([^"']*)["'])` +
      `(?=[^>]*\\bname\\s*=\\s*["']${key}["'])[^>]*>`,
      "i"
    )
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);

    if (match && match[1]) {
      return decodeEntities(match[1].trim());
    }
  }

  return null;
}

function getTitle(html) {
  const title =
    getMeta(html, "og:title") ||
    getMeta(html, "twitter:title") ||
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];

  return title
    ? decodeEntities(title.replace(/<[^>]*>/g, "").trim())
    : null;
}

function getDescription(html) {
  return (
    getMeta(html, "og:description") ||
    getMeta(html, "twitter:description") ||
    getMeta(html, "description") ||
    null
  );
}

function getThumbnail(html) {
  return (
    getMeta(html, "og:image") ||
    getMeta(html, "og:image:secure_url") ||
    getMeta(html, "og:image:url") ||
    getMeta(html, "twitter:image") ||
    getMeta(html, "twitter:image:src") ||
    null
  );
}

function getAuthor(html) {
  return (
    getMeta(html, "author") ||
    getMeta(html, "og:video:release_date") ||
    getMeta(html, "twitter:creator") ||
    null
  );
}

function getContentType(html) {
  return getMeta(html, "og:type") || null;
}

/*
 * Extract useful fields from JSON-LD when a page provides it.
 */
function getJsonLd(html) {
  const scripts = html.matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );

  for (const match of scripts) {
    try {
      const data = JSON.parse(
        decodeEntities(match[1].trim())
      );

      const objects = Array.isArray(data) ? data : [data];

      for (const item of objects) {
        if (!item || typeof item !== "object") {
          continue;
        }

        const image = Array.isArray(item.image)
          ? item.image[0]
          : item.image;

        const author = Array.isArray(item.author)
          ? item.author[0]
          : item.author;

        return {
          title:
            item.headline ||
            item.name ||
            null,

          description:
            item.description ||
            null,

          thumbnail:
            typeof image === "string"
              ? image
              : image?.url || image?.contentUrl || null,

          author:
            typeof author === "string"
              ? author
              : author?.name || null,

          type:
            Array.isArray(item["@type"])
              ? item["@type"][0]
              : item["@type"] || null
        };
      }
    } catch {
      // Ignore invalid JSON-LD and continue.
    }
  }

  return {};
}

function normalizeImage(image, pageUrl) {
  if (!image) {
    return null;
  }

  try {
    const parsed = new URL(image, pageUrl);

    if (parsed.protocol !== "https:") {
      return null;
    }

    return parsed.href;
  } catch {
    return null;
  }
}

/*
 * Remove common tracking parameters from the returned URL.
 * This does not change the source metadata request.
 */
function cleanUrl(url) {
  const cleaned = new URL(url.href);

  const trackingParameters = [
    "si",
    "obrf",
    "igsh",
    "igshid",
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_content",
    "utm_term",
    "fbclid",
    "gclid"
  ];

  for (const parameter of trackingParameters) {
    cleaned.searchParams.delete(parameter);
  }

  cleaned.hash = "";

  return cleaned.href;
}

function isAllowedHost(platform, hostname) {
  return PLATFORM_DOMAINS[platform]?.includes(
    hostname.toLowerCase()
  ) ?? false;
}

/*
 * Validate the URL before making an external request.
 */
function validateTarget(platform, rawUrl) {
  if (
    typeof rawUrl !== "string" ||
    !rawUrl.trim() ||
    rawUrl.length > 4096
  ) {
    throw new Error("INVALID_URL");
  }

  let target;

  try {
    target = new URL(rawUrl.trim());
  } catch {
    throw new Error("INVALID_URL");
  }

  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    target.port
  ) {
    throw new Error("INVALID_URL");
  }

  if (!isAllowedHost(platform, target.hostname)) {
    throw new Error("PLATFORM_MISMATCH");
  }

  return target;
}

/*
 * Fetch HTML while checking each redirect destination.
 * This prevents redirects to arbitrary external hosts.
 */
async function fetchHtml(platform, initialUrl) {
  let currentUrl = new URL(initialUrl.href);

  for (let attempt = 0; attempt <= MAX_REDIRECTS; attempt++) {
    if (
      currentUrl.protocol !== "https:" ||
      !isAllowedHost(platform, currentUrl.hostname)
    ) {
      throw new Error("UPSTREAM_REDIRECT_BLOCKED");
    }

    const response = await fetch(currentUrl.href, {
      method: "GET",
      redirect: "manual",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
          "AppleWebKit/537.36 (KHTML, like Gecko) " +
          "Chrome/131.0.0.0 Safari/537.36",

        "Accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",

        "Accept-Language": "en-US,en;q=0.9"
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT)
    });

    if (
      [301, 302, 303, 307, 308].includes(response.status)
    ) {
      const location = response.headers.get("location");

      if (!location || attempt === MAX_REDIRECTS) {
        throw new Error("UPSTREAM_REDIRECT_LIMIT");
      }

      const nextUrl = new URL(location, currentUrl);

      if (
        nextUrl.protocol !== "https:" ||
        !isAllowedHost(platform, nextUrl.hostname)
      ) {
        throw new Error("UPSTREAM_REDIRECT_BLOCKED");
      }

      currentUrl = nextUrl;
      continue;
    }

    if (!response.ok) {
      throw new Error(`UPSTREAM_HTTP_${response.status}`);
    }

    const contentType =
      response.headers.get("content-type") || "";

    if (
      !contentType.includes("text/html") &&
      !contentType.includes("application/xhtml+xml")
    ) {
      throw new Error("UPSTREAM_NOT_HTML");
    }

    const declaredLength = Number(
      response.headers.get("content-length") || 0
    );

    if (declaredLength > MAX_HTML_SIZE) {
      throw new Error("UPSTREAM_RESPONSE_TOO_LARGE");
    }

    const html = await response.text();

    if (html.length > MAX_HTML_SIZE) {
      throw new Error("UPSTREAM_RESPONSE_TOO_LARGE");
    }

    return {
      html,
      finalUrl: currentUrl
    };
  }

  throw new Error("UPSTREAM_REDIRECT_LIMIT");
}

/*
 * HTML-based metadata extraction.
 *
 * Instagram may return limited metadata or a login page.
 * In that case, the result may still be incomplete.
 */
async function fetchOpenGraph(platform, url) {
  const { html, finalUrl } = await fetchHtml(platform, url);

  const jsonLd = getJsonLd(html);

  const title =
    getTitle(html) ||
    jsonLd.title ||
    null;

  const description =
    getDescription(html) ||
    jsonLd.description ||
    null;

  const thumbnail = normalizeImage(
    getThumbnail(html) ||
      jsonLd.thumbnail ||
      null,
    finalUrl.href
  );

  const author =
    getAuthor(html) ||
    jsonLd.author ||
    null;

  let type =
    getContentType(html) ||
    jsonLd.type ||
    null;

  if (platform === "ig" && url.pathname.includes("/reel/")) {
    type = "video";
  } else if (platform === "yt" && url.pathname.includes("/shorts/")) {
    type = "video";
  } else if (platform === "tt") {
    type = "video";
  }

  return {
    title,
    description,
    thumbnail,
    author,
    type: type || "website"
  };
}

/*
 * YouTube oEmbed.
 * Keeps the existing YouTube approach.
 */
async function fetchYouTube(url) {
  const endpoint = new URL(
    "https://www.youtube.com/oembed"
  );

  endpoint.searchParams.set("url", url.href);
  endpoint.searchParams.set("format", "json");

  const response = await fetch(endpoint.href, {
    headers: {
      Accept: "application/json"
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT)
  });

  if (!response.ok) {
    throw new Error(`YOUTUBE_OEMBED_HTTP_${response.status}`);
  }

  const data = await response.json();

  return {
    title: data.title || null,
    description: null,
    thumbnail: normalizeImage(
      data.thumbnail_url,
      url.href
    ),
    author: data.author_name || null,
    type: "video"
  };
}

/*
 * TikTok oEmbed.
 */
async function fetchTikTok(url) {
  const endpoint = new URL(
    "https://www.tiktok.com/oembed"
  );

  endpoint.searchParams.set("url", url.href);

  const response = await fetch(endpoint.href, {
    headers: {
      Accept: "application/json"
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT)
  });

  if (!response.ok) {
    throw new Error(`TIKTOK_OEMBED_HTTP_${response.status}`);
  }

  const data = await response.json();

  return {
    title: data.title || null,
    description: data.title || null,
    thumbnail: normalizeImage(
      data.thumbnail_url,
      url.href
    ),
    author: data.author_name || null,
    type: data.type || "video"
  };
}

/*
 * Route metadata extraction to the correct platform.
 */
async function getMetadata(platform, url) {
  if (platform === "yt") {
    return fetchYouTube(url);
  }

  if (platform === "tt") {
    return fetchTikTok(url);
  }

  if (platform === "ig" || platform === "fb") {
    return fetchOpenGraph(platform, url);
  }

  throw new Error("UNSUPPORTED_PLATFORM");
}

export default {
  async fetch(request) {
    const requestUrl = new URL(request.url);

    if (request.method !== "GET") {
      return errorResponse(
        "METHOD_NOT_ALLOWED",
        "Only GET requests are supported.",
        405
      );
    }

    /*
     * API health endpoint.
     */
    if (requestUrl.pathname === "/") {
      return json({
        success: true,
        name: "KeepItBack Metadata API",
        version: "1.1.0",
        platforms: Object.keys(PLATFORM_NAMES),
        usage: {
          query: "/yt?url=<encoded-url>",
          path: "/yt/<url>"
        }
      });
    }

    const parts = requestUrl.pathname
      .split("/")
      .filter(Boolean);

    const platform = parts[0];

    if (!PLATFORM_NAMES[platform]) {
      return errorResponse(
        "UNSUPPORTED_PLATFORM",
        "Supported platform codes: yt, ig, tt, fb.",
        404
      );
    }

    /*
     * Preferred format:
     * /ig?url=https%3A%2F%2Fwww.instagram.com%2Freel%2F...
     */
    let rawUrl = requestUrl.searchParams.get("url");

    /*
     * Also support the path format:
     * /ig/https://www.instagram.com/reel/SHORTCODE/
     *
     * Query format is recommended because URLs contain
     * their own slashes and query parameters.
     */
    if (!rawUrl && parts.length > 1) {
      rawUrl = parts.slice(1).join("/");

      try {
        rawUrl = decodeURIComponent(rawUrl);
      } catch {
        return errorResponse(
          "INVALID_URL",
          "The supplied URL is incorrectly encoded."
        );
      }
    }

    if (!rawUrl) {
      return errorResponse(
        "MISSING_URL",
        "Provide a URL using ?url=<encoded-url>."
      );
    }

    let target;

    try {
      target = validateTarget(platform, rawUrl);
    } catch (error) {
      if (error.message === "PLATFORM_MISMATCH") {
        return errorResponse(
          "PLATFORM_MISMATCH",
          "The URL does not belong to the selected platform."
        );
      }

      return errorResponse(
        "INVALID_URL",
        "Provide a valid HTTPS URL from a supported domain."
      );
    }

    try {
      const metadata = await getMetadata(platform, target);

      /*
       * Don't treat an empty login page as a successful result.
       */
      if (
        !metadata.title &&
        !metadata.thumbnail &&
        !metadata.description
      ) {
        return errorResponse(
          "METADATA_UNAVAILABLE",
          "No usable metadata was found. The platform may have returned a login page, restricted the request, or omitted metadata.",
          502
        );
      }

      return json({
        success: true,
        platform: PLATFORM_NAMES[platform],
        url: cleanUrl(target),
        title: metadata.title || null,
        description: metadata.description || null,
        thumbnail: metadata.thumbnail || null,
        author: metadata.author || null,
        type: metadata.type || "video"
      });
    } catch (error) {
      /*
       * Keep detailed diagnostics in Cloudflare logs.
       * Do not expose upstream response bodies to clients.
       */
      console.error("Metadata extraction failed", {
        platform,
        error: error instanceof Error
          ? error.message
          : String(error)
      });

      let message =
        "The platform did not provide usable metadata. The content may be private, unavailable, or restricted.";

      if (
        error instanceof Error &&
        error.message.startsWith("UPSTREAM_HTTP_")
      ) {
        message =
          "The upstream platform returned an HTTP error. Check Cloudflare Worker logs for details.";
      } else if (
        error instanceof Error &&
        error.message.startsWith("UPSTREAM_REDIRECT")
      ) {
        message =
          "The upstream platform redirected the request somewhere that could not be followed safely.";
      } else if (
        error instanceof Error &&
        error.message === "UPSTREAM_NOT_HTML"
      ) {
        message =
          "The upstream platform did not return an HTML page.";
      } else if (
        error instanceof Error &&
        error.name === "TimeoutError"
      ) {
        message =
          "The upstream platform took too long to respond.";
      }

      return errorResponse(
        "METADATA_UNAVAILABLE",
        message,
        502
      );
    }
  }
};
