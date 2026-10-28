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
  "Cache-Control": "public, max-age=300",
  "X-Content-Type-Options": "nosniff"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: JSON_HEADERS
  });
}

function errorResponse(code, message, status = 400) {
  return json({
    success: false,
    error: { code, message }
  }, status);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getMeta(html, property) {
  const key = escapeRegex(property);

  const patterns = [
    new RegExp(
      `<meta\\b[^>]*\\bproperty=["']${key}["'][^>]*\\bcontent=["']([^"']*)["'][^>]*>`,
      "i"
    ),
    new RegExp(
      `<meta\\b[^>]*\\bname=["']${key}["'][^>]*\\bcontent=["']([^"']*)["'][^>]*>`,
      "i"
    ),
    new RegExp(
      `<meta\\b[^>]*\\bcontent=["']([^"']*)["'][^>]*\\bproperty=["']${key}["'][^>]*>`,
      "i"
    ),
    new RegExp(
      `<meta\\b[^>]*\\bcontent=["']([^"']*)["'][^>]*\\bname=["']${key}["'][^>]*>`,
      "i"
    )
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);

    if (match) {
      return decodeEntities(match[1]);
    }
  }

  return null;
}

function decodeEntities(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) =>
      String.fromCodePoint(Number(n))
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
      String.fromCodePoint(parseInt(n, 16))
    );
}

function getTitle(html) {
  return (
    getMeta(html, "og:title") ||
    getMeta(html, "twitter:title") ||
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
      ?.replace(/<[^>]*>/g, "")
      .trim() ||
    null
  );
}

function getDescription(html) {
  return (
    getMeta(html, "og:description") ||
    getMeta(html, "description") ||
    getMeta(html, "twitter:description") ||
    null
  );
}

function getThumbnail(html) {
  return (
    getMeta(html, "og:image") ||
    getMeta(html, "og:image:url") ||
    getMeta(html, "twitter:image") ||
    getMeta(html, "twitter:image:src") ||
    null
  );
}

function getAuthor(html) {
  return (
    getMeta(html, "author") ||
    getMeta(html, "og:site_name") ||
    null
  );
}

function normalizeImage(image, pageUrl) {
  if (!image) return null;

  try {
    const parsed = new URL(image, pageUrl);

    if (parsed.protocol !== "https:" &&
        parsed.protocol !== "http:") {
      return null;
    }

    return parsed.href;
  } catch {
    return null;
  }
}

function validateTarget(platform, rawUrl) {
  if (!rawUrl || rawUrl.length > 4096) {
    throw new Error("INVALID_URL");
  }

  let target;

  try {
    target = new URL(rawUrl);
  } catch {
    throw new Error("INVALID_URL");
  }

  if (target.protocol !== "https:") {
    throw new Error("INVALID_URL");
  }

  if (
    target.username ||
    target.password ||
    target.port
  ) {
    throw new Error("INVALID_URL");
  }

  const allowed = PLATFORM_DOMAINS[platform];

  if (!allowed || !allowed.includes(target.hostname.toLowerCase())) {
    throw new Error("PLATFORM_MISMATCH");
  }

  return target;
}

async function fetchHtml(url) {
  const response = await fetch(url.href, {
    method: "GET",
    redirect: "error",
    headers: {
      "User-Agent": "KeepItBackMetadata/1.0",
      "Accept": "text/html,application/xhtml+xml"
    },
    signal: AbortSignal.timeout(8000)
  });

  if (!response.ok) {
    throw new Error("UPSTREAM_ERROR");
  }

  const contentType = response.headers.get("content-type") || "";

  if (!contentType.includes("text/html") &&
      !contentType.includes("application/xhtml+xml")) {
    throw new Error("UPSTREAM_ERROR");
  }

  const declaredLength = Number(
    response.headers.get("content-length") || 0
  );

  if (declaredLength > 1_000_000) {
    throw new Error("UPSTREAM_ERROR");
  }

  const html = await response.text();

  if (html.length > 1_000_000) {
    throw new Error("UPSTREAM_ERROR");
  }

  return html;
}

async function fetchTikTok(url) {
  const endpoint = new URL("https://www.tiktok.com/oembed");
  endpoint.searchParams.set("url", url.href);

  const response = await fetch(endpoint.href, {
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(8000)
  });

  if (!response.ok) {
    throw new Error("METADATA_UNAVAILABLE");
  }

  const data = await response.json();

  return {
    title: data.title || null,
    description: data.title || null,
    thumbnail: normalizeImage(data.thumbnail_url, url.href),
    author: data.author_name || null,
    type: data.type || "video"
  };
}

async function fetchYouTube(url) {
  const endpoint = new URL("https://www.youtube.com/oembed");
  endpoint.searchParams.set("url", url.href);
  endpoint.searchParams.set("format", "json");

  const response = await fetch(endpoint.href, {
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(8000)
  });

  if (!response.ok) {
    throw new Error("METADATA_UNAVAILABLE");
  }

  const data = await response.json();

  return {
    title: data.title || null,
    description: null,
    thumbnail: normalizeImage(data.thumbnail_url, url.href),
    author: data.author_name || null,
    type: data.type || "video"
  };
}

async function fetchOpenGraph(url) {
  const html = await fetchHtml(url);

  return {
    title: getTitle(html),
    description: getDescription(html),
    thumbnail: normalizeImage(getThumbnail(html), url.href),
    author: getAuthor(html),
    type: getMeta(html, "og:type") || "website"
  };
}

async function getMetadata(platform, url) {
  if (platform === "yt") {
    return fetchYouTube(url);
  }

  if (platform === "tt") {
    return fetchTikTok(url);
  }

  // Instagram and Facebook require additional care:
  // their page HTML may block automated requests.
  // Use supported APIs for reliable production metadata.
  return fetchOpenGraph(url);
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

    if (requestUrl.pathname === "/") {
      return json({
        success: true,
        name: "KeepItBack Metadata API",
        version: "1.0.0",
        platforms: Object.keys(PLATFORM_NAMES),
        usage: "/yt?url=<encoded-url>"
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

    let rawUrl = requestUrl.searchParams.get("url");

    // Also support /yt/<encoded-url>
    if (!rawUrl && parts.length > 1) {
      rawUrl = parts.slice(1).join("/");

      try {
        rawUrl = decodeURIComponent(rawUrl);
      } catch {
        return errorResponse(
          "INVALID_URL",
          "The URL is not correctly encoded."
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
      return errorResponse(
        error.message === "PLATFORM_MISMATCH"
          ? "PLATFORM_MISMATCH"
          : "INVALID_URL",
        error.message === "PLATFORM_MISMATCH"
          ? "The URL does not belong to the selected platform."
          : "Provide a valid HTTPS URL from a supported domain."
      );
    }

    try {
      const metadata = await getMetadata(platform, target);

      if (!metadata.title && !metadata.thumbnail &&
          !metadata.description) {
        return errorResponse(
          "METADATA_UNAVAILABLE",
          "No usable metadata was returned.",
          502
        );
      }

      return json({
        success: true,
        platform: PLATFORM_NAMES[platform],
        url: target.href,
        title: metadata.title,
        description: metadata.description,
        thumbnail: metadata.thumbnail,
        author: metadata.author,
        type: metadata.type
      });
    } catch {
      return errorResponse(
        "METADATA_UNAVAILABLE",
        "The platform did not provide usable metadata. The content may be private, unavailable, or restricted.",
        502
      );
    }
  }
};
