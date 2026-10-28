/**
 * KeepItBack Metadata API
 * Cloudflare Workers
 *
 * Supported platforms:
 *   YouTube    /yt?url=<encoded-url>
 *   Instagram  /ig?url=<encoded-url>
 *   TikTok     /tt?url=<encoded-url>
 *   Facebook   /fb?url=<encoded-url>
 *
 * Instagram/Facebook metadata is extracted from public HTML.
 * YouTube/TikTok use their oEmbed endpoints.
 */

const VERSION = "1.3.0";

const PLATFORM_DOMAINS = {
  yt: [
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "youtu.be",
  ],
  ig: [
    "instagram.com",
    "www.instagram.com",
  ],
  tt: [
    "tiktok.com",
    "www.tiktok.com",
    "m.tiktok.com",
  ],
  fb: [
    "facebook.com",
    "www.facebook.com",
    "m.facebook.com",
    "fb.watch",
  ],
};

const PLATFORM_NAMES = {
  yt: "youtube",
  ig: "instagram",
  tt: "tiktok",
  fb: "facebook",
};

const GENERIC_TITLES = new Set([
  "instagram",
  "facebook",
  "tiktok",
  "youtube",
  "log in • instagram",
  "log in to instagram",
  "instagram login",
  "facebook - log in or sign up",
  "log in or sign up to view",
  "log in to facebook",
  "tiktok - make your day",
  "youtube",
]);

const GENERIC_DESCRIPTIONS = new Set([
  "instagram",
  "facebook",
  "tiktok",
  "youtube",
  "log in to instagram",
  "log in to view this content",
]);

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

const FETCH_TIMEOUT = 10000;
const MAX_HTML_SIZE = 1_000_000;
const MAX_REDIRECTS = 3;
const MAX_URL_LENGTH = 4096;

/* -------------------------------------------------------
   RESPONSE HELPERS
------------------------------------------------------- */

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: JSON_HEADERS,
  });
}

function errorResponse(code, message, status = 400) {
  return json(
    {
      success: false,
      error: {
        code,
        message,
      },
    },
    status
  );
}

function isGenericTitle(value) {
  if (typeof value !== "string") {
    return true;
  }

  return GENERIC_TITLES.has(
    value.trim().toLowerCase()
  );
}

function cleanGenericDescription(value) {
  if (!value || typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();

  if (GENERIC_DESCRIPTIONS.has(normalized)) {
    return null;
  }

  return value.trim() || null;
}

/* -------------------------------------------------------
   HTML METADATA EXTRACTION
------------------------------------------------------- */

function decodeEntities(value) {
  if (!value) return null;

  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (match, digits) => {
      const code = Number(digits);

      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    })
    .replace(/&#x([0-9a-f]+);/gi, (match, digits) => {
      const code = parseInt(digits, 16);

      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    });
}

/**
 * Extracts a tag attribute regardless of attribute order.
 */
function getAttribute(tag, attributeName) {
  const escaped = attributeName.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );

  const pattern = new RegExp(
    "\\b" +
      escaped +
      "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))",
    "i"
  );

  const match = tag.match(pattern);

  if (!match) return null;

  return decodeEntities(
    match[1] ?? match[2] ?? match[3] ?? ""
  );
}

/**
 * Finds a meta tag by its property or name attribute.
 */
function getMeta(html, key) {
  const tags =
    html.match(/<meta\b[^>]*>/gi) || [];

  for (const tag of tags) {
    const property =
      getAttribute(tag, "property");

    const name =
      getAttribute(tag, "name");

    const itemKey = (
      property || name || ""
    ).trim().toLowerCase();

    if (itemKey !== key.toLowerCase()) {
      continue;
    }

    const content =
      getAttribute(tag, "content");

    if (content) {
      return content.trim();
    }
  }

  return null;
}

function getTitle(html) {
  const metaTitle =
    getMeta(html, "og:title") ||
    getMeta(html, "twitter:title");

  if (metaTitle) {
    return metaTitle.trim();
  }

  const titleMatch = html.match(
    /<title\b[^>]*>([\s\S]*?)<\/title>/i
  );

  if (!titleMatch) return null;

  return decodeEntities(
    titleMatch[1]
      .replace(/<[^>]*>/g, "")
      .trim()
  );
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
    getMeta(html, "twitter:creator") ||
    getMeta(html, "article:author") ||
    getMeta(html, "og:video:tag") ||
    null
  );
}

function getContentType(html) {
  return getMeta(html, "og:type");
}

/* -------------------------------------------------------
   JSON-LD EXTRACTION
------------------------------------------------------- */

function getJsonLd(html) {
  const scriptPattern =
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

  const scripts = html.matchAll(scriptPattern);

  for (const script of scripts) {
    try {
      const parsed = JSON.parse(
        script[1].trim()
      );

      const roots = Array.isArray(parsed)
        ? parsed
        : [parsed];

      for (const root of roots) {
        if (!root || typeof root !== "object") {
          continue;
        }

        const candidates = Array.isArray(
          root["@graph"]
        )
          ? root["@graph"]
          : [root];

        for (const item of candidates) {
          if (
            !item ||
            typeof item !== "object"
          ) {
            continue;
          }

          const image = Array.isArray(item.image)
            ? item.image[0]
            : item.image;

          const author = Array.isArray(item.author)
            ? item.author[0]
            : item.author;

          const authorName =
            typeof author === "string"
              ? author
              : author?.name || null;

          const thumbnail =
            typeof image === "string"
              ? image
              : image?.url ||
                image?.contentUrl ||
                null;

          const result = {
            title:
              item.headline ||
              item.name ||
              null,

            description:
              item.description || null,

            thumbnail,

            author: authorName,

            type: Array.isArray(item["@type"])
              ? item["@type"][0]
              : item["@type"] || null,
          };

          if (
            result.title ||
            result.description ||
            result.thumbnail ||
            result.author
          ) {
            return result;
          }
        }
      }
    } catch {
      // Ignore invalid JSON-LD and inspect the next script.
    }
  }

  return {};
}

/* -------------------------------------------------------
   URL VALIDATION
------------------------------------------------------- */

function cleanUrl(url) {
  const result = new URL(url.href);

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
    "gclid",
  ];

  for (const parameter of trackingParameters) {
    result.searchParams.delete(parameter);
  }

  result.hash = "";

  return result.href;
}

function isAllowedHost(platform, hostname) {
  return (
    PLATFORM_DOMAINS[platform]?.includes(
      hostname.toLowerCase()
    ) ?? false
  );
}

function validateTarget(platform, rawUrl) {
  if (
    typeof rawUrl !== "string" ||
    !rawUrl.trim() ||
    rawUrl.length > MAX_URL_LENGTH
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

  if (
    !isAllowedHost(
      platform,
      target.hostname
    )
  ) {
    throw new Error("PLATFORM_MISMATCH");
  }

  return target;
}

/* -------------------------------------------------------
   SAFE HTML FETCHING
------------------------------------------------------- */

async function fetchHtml(platform, initialUrl) {
  let currentUrl = new URL(
    initialUrl.href
  );

  for (
    let attempt = 0;
    attempt <= MAX_REDIRECTS;
    attempt++
  ) {
    if (
      currentUrl.protocol !== "https:" ||
      !isAllowedHost(
        platform,
        currentUrl.hostname
      )
    ) {
      throw new Error(
        "UPSTREAM_REDIRECT_BLOCKED"
      );
    }

    const response = await fetch(
      currentUrl.href,
      {
        method: "GET",
        redirect: "manual",

        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/131.0.0.0 Safari/537.36",

          Accept:
            "text/html,application/xhtml+xml," +
            "application/xml;q=0.9,*/*;q=0.8",

          "Accept-Language":
            "en-US,en;q=0.9",
        },

        signal: AbortSignal.timeout(
          FETCH_TIMEOUT
        ),
      }
    );

    if (
      [301, 302, 303, 307, 308].includes(
        response.status
      )
    ) {
      const location =
        response.headers.get("location");

      if (
        !location ||
        attempt === MAX_REDIRECTS
      ) {
        throw new Error(
          "UPSTREAM_REDIRECT_LIMIT"
        );
      }

      const nextUrl = new URL(
        location,
        currentUrl
      );

      if (
        nextUrl.protocol !== "https:" ||
        !isAllowedHost(
          platform,
          nextUrl.hostname
        )
      ) {
        throw new Error(
          "UPSTREAM_REDIRECT_BLOCKED"
        );
      }

      currentUrl = nextUrl;

      continue;
    }

    if (!response.ok) {
      throw new Error(
        `UPSTREAM_HTTP_${response.status}`
      );
    }

    const contentType =
      response.headers.get("content-type") || "";

    if (
      !contentType.includes("text/html") &&
      !contentType.includes(
        "application/xhtml+xml"
      )
    ) {
      throw new Error(
        "UPSTREAM_NOT_HTML"
      );
    }

    const declaredLength = Number(
      response.headers.get("content-length") || 0
    );

    if (declaredLength > MAX_HTML_SIZE) {
      throw new Error(
        "UPSTREAM_RESPONSE_TOO_LARGE"
      );
    }

    const html = await response.text();

    if (html.length > MAX_HTML_SIZE) {
      throw new Error(
        "UPSTREAM_RESPONSE_TOO_LARGE"
      );
    }

    return {
      html,
      finalUrl: currentUrl,
    };
  }

  throw new Error(
    "UPSTREAM_REDIRECT_LIMIT"
  );
}

/* -------------------------------------------------------
   INSTAGRAM / FACEBOOK
------------------------------------------------------- */

async function fetchOpenGraph(platform, url) {
  const { html, finalUrl } =
    await fetchHtml(platform, url);

  const jsonLd = getJsonLd(html);

  const htmlTitle = getTitle(html);

  // Never accept a generic platform title.
  const title = !isGenericTitle(htmlTitle)
    ? htmlTitle
    : (
        !isGenericTitle(jsonLd.title)
          ? jsonLd.title
          : null
      );

  const rawDescription =
    getDescription(html) ||
    jsonLd.description ||
    null;

  const description =
    cleanGenericDescription(
      rawDescription
    );

  const rawThumbnail =
    getThumbnail(html) ||
    jsonLd.thumbnail ||
    null;

  const thumbnail = normalizeImage(
    rawThumbnail,
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

  if (
    platform === "ig" &&
    /\/(reel|reels|p)\//i.test(url.pathname)
  ) {
    type = "video";
  }

  if (platform === "tt") {
    type = "video";
  }

  return {
    title,
    description,
    thumbnail,
    author,
    type: type || "video",
  };
}

/* -------------------------------------------------------
   YOUTUBE
------------------------------------------------------- */

async function fetchYouTube(url) {
  const endpoint = new URL(
    "https://www.youtube.com/oembed"
  );

  endpoint.searchParams.set(
    "url",
    url.href
  );

  endpoint.searchParams.set(
    "format",
    "json"
  );

  const response = await fetch(
    endpoint.href,
    {
      headers: {
        Accept: "application/json",
      },

      signal: AbortSignal.timeout(
        FETCH_TIMEOUT
      ),
    }
  );

  if (!response.ok) {
    throw new Error(
      `YOUTUBE_OEMBED_HTTP_${response.status}`
    );
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
    type: "video",
  };
}

/* -------------------------------------------------------
   TIKTOK
------------------------------------------------------- */

async function fetchTikTok(url) {
  const endpoint = new URL(
    "https://www.tiktok.com/oembed"
  );

  endpoint.searchParams.set(
    "url",
    url.href
  );

  const response = await fetch(
    endpoint.href,
    {
      headers: {
        Accept: "application/json",
      },

      signal: AbortSignal.timeout(
        FETCH_TIMEOUT
      ),
    }
  );

  if (!response.ok) {
    throw new Error(
      `TIKTOK_OEMBED_HTTP_${response.status}`
    );
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
    type: data.type || "video",
  };
}

/* -------------------------------------------------------
   IMAGE URL NORMALIZATION
------------------------------------------------------- */

function normalizeImage(image, pageUrl) {
  if (
    !image ||
    typeof image !== "string"
  ) {
    return null;
  }

  try {
    const parsed = new URL(
      image,
      pageUrl
    );

    if (
      parsed.protocol !== "https:"
    ) {
      return null;
    }

    return parsed.href;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------
   PLATFORM ROUTER
------------------------------------------------------- */

async function getMetadata(platform, url) {
  if (platform === "yt") {
    return fetchYouTube(url);
  }

  if (platform === "tt") {
    return fetchTikTok(url);
  }

  if (
    platform === "ig" ||
    platform === "fb"
  ) {
    return fetchOpenGraph(
      platform,
      url
    );
  }

  throw new Error(
    "UNSUPPORTED_PLATFORM"
  );
}

/* -------------------------------------------------------
   MAIN CLOUDFLARE WORKER
------------------------------------------------------- */

export default {
  async fetch(request) {
    const requestUrl = new URL(
      request.url
    );

    if (request.method !== "GET") {
      return errorResponse(
        "METHOD_NOT_ALLOWED",
        "Only GET requests are supported.",
        405
      );
    }

    // API information endpoint.
    if (requestUrl.pathname === "/") {
      return json({
        success: true,
        name: "KeepItBack Metadata API",
        version: VERSION,

        platforms: Object.keys(
          PLATFORM_NAMES
        ),

        usage: {
          query: "/yt?url=<encoded-url>",
          instagram: "/ig?url=<encoded-url>",
          tiktok: "/tt?url=<encoded-url>",
          facebook: "/fb?url=<encoded-url>",
        },
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

    let rawUrl =
      requestUrl.searchParams.get("url");

    // Optional path-based URL format.
    if (!rawUrl && parts.length > 1) {
      rawUrl = parts
        .slice(1)
        .join("/");

      try {
        rawUrl = decodeURIComponent(
          rawUrl
        );
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
      target = validateTarget(
        platform,
        rawUrl
      );
    } catch (error) {
      if (
        error.message ===
        "PLATFORM_MISMATCH"
      ) {
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
      const metadata = await getMetadata(
        platform,
        target
      );

      // Filter generic titles before returning success.
      const hasUsefulTitle =
        typeof metadata.title === "string" &&
        !isGenericTitle(metadata.title);

      const description =
        cleanGenericDescription(
          metadata.description
        );

      const thumbnail =
        metadata.thumbnail || null;

      // No actual metadata? Do not return success.
      if (
        !hasUsefulTitle &&
        !description &&
        !thumbnail
      ) {
        return errorResponse(
          "METADATA_UNAVAILABLE",

          "No usable metadata was found. The platform may have returned a login page, restricted the request, or omitted metadata.",

          502
        );
      }

      return json({
        success: true,

        platform:
          PLATFORM_NAMES[platform],

        url: cleanUrl(target),

        title: hasUsefulTitle
          ? metadata.title
          : null,

        description:
          description || null,

        thumbnail,

        author:
          metadata.author || null,

        type:
          metadata.type || "video",
      });
    } catch (error) {
      console.error(
        "Metadata extraction failed",
        {
          platform,

          error:
            error instanceof Error
              ? error.message
              : String(error),
        }
      );

      let message =
        "The platform did not provide usable metadata. The content may be private, unavailable, or restricted.";

      if (
        error instanceof Error &&
        error.message.startsWith(
          "UPSTREAM_HTTP_"
        )
      ) {
        message =
          "The upstream platform returned an HTTP error. Check Cloudflare Worker logs for details.";
      } else if (
        error instanceof Error &&
        error.message.startsWith(
          "UPSTREAM_REDIRECT"
        )
      ) {
        message =
          "The upstream platform redirected the request somewhere that could not be followed safely.";
      } else if (
        error instanceof Error &&
        error.message ===
          "UPSTREAM_NOT_HTML"
      ) {
        message =
          "The upstream platform did not return an HTML page.";
      } else if (
        error instanceof Error &&
        error.message ===
          "UPSTREAM_RESPONSE_TOO_LARGE"
      ) {
        message =
          "The upstream HTML response exceeded the allowed size.";
      } else if (
        error instanceof Error &&
        (
          error.name === "TimeoutError" ||
          error.name === "AbortError"
        )
      ) {
        message =
          "The upstream platform took too long to respond.";
      } else if (
        error instanceof Error &&
        error.message.startsWith(
          "YOUTUBE_OEMBED_HTTP_"
        )
      ) {
        message =
          "YouTube could not provide metadata for this URL.";
      } else if (
        error instanceof Error &&
        error.message.startsWith(
          "TIKTOK_OEMBED_HTTP_"
        )
      ) {
        message =
          "TikTok could not provide metadata for this URL.";
      }

      return errorResponse(
        "METADATA_UNAVAILABLE",
        message,
        502
      );
    }
  },
};
