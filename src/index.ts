/**
 * Cloudflare Worker 跨域透明代理
 *
 * 使用方式：
 *   GET  /?url=https://example.com/api/data
 *   POST /?url=https://example.com/upload  (带 body)
 *
 * 浏览器 fetch 效果与直接访问目标 URL 一致。
 * HTML 页面中的链接会自动改写为走代理的地址。
 */

// ─── 不解密的 Hop-by-hop 头（不应转发） ───
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

// 内部标记头：防止 Worker 子请求被自身再次拦截导致死循环
const INTERNAL_MARKER = "X-Proxy-Internal";

// ─── 提取目标 URL ───

function extractTargetURL(request: Request): string | null {
  const url = new URL(request.url);

  const queryTarget = url.searchParams.get("url");
  if (queryTarget) {
    return queryTarget;
  }

  const headerTarget = request.headers.get("X-Proxy-Target");
  if (headerTarget) {
    return headerTarget;
  }

  return null;
}

// ─── 过滤请求头 ───

function filterHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (!HOP_BY_HOP_HEADERS.has(lower) && lower !== INTERNAL_MARKER.toLowerCase()) {
      result[key] = value;
    }
  });
  return result;
}

// ─── 构建 CORS 响应头 ───

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400",
  };
}

// ─── 错误响应 ───

function errorResponse(status: number, message: string, request: Request): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(request),
    },
  });
}

// ─── URL 改写 ───

const NON_REWRITABLE = /^(#|javascript:|mailto:|tel:|data:|blob:|about:)/i;

function rewriteURL(raw: string, proxyOrigin: string, targetOrigin: string): string | null {
  if (!raw || NON_REWRITABLE.test(raw)) return null;

  try {
    const absolute = new URL(raw, targetOrigin).toString();
    // 不改写非同源的 URL（外部 CDN、第三方资源等）
    // 如需跨域加载外部资源，注释掉下面这行
    // if (!absolute.startsWith(targetOrigin)) return null;
    return `${proxyOrigin}/?url=${encodeURIComponent(absolute)}`;
  } catch {
    return null;
  }
}

// ─── srcset 改写 ───

function rewriteSrcset(raw: string, proxyOrigin: string, targetOrigin: string): string | null {
  if (!raw) return null;

  const parts = raw.split(",").map((entry) => {
    const trimmed = entry.trim();
    // 格式: "url 1x" 或 "url 480w"
    const match = trimmed.match(/^(\S+)(\s+.+)?$/);
    if (!match) return entry;

    const rewritten = rewriteURL(match[1], proxyOrigin, targetOrigin);
    if (!rewritten) return entry;

    return match[2] ? `${rewritten}${match[2]}` : rewritten;
  });

  const result = parts.join(", ");
  return result !== raw ? result : null;
}

// ─── HTMLRewriter 处理器 ───

/**
 * 通用单属性 URL 改写器
 */
function urlHandler(attr: string, proxyOrigin: string, targetOrigin: string) {
  return {
    element(element: Element) {
      const value = element.getAttribute(attr);
      if (!value) return;
      const rewritten = rewriteURL(value, proxyOrigin, targetOrigin);
      if (rewritten) element.setAttribute(attr, rewritten);
    },
  };
}

/**
 * srcset 属性改写器
 */
function srcsetHandler(proxyOrigin: string, targetOrigin: string) {
  return {
    element(element: Element) {
      const value = element.getAttribute("srcset");
      if (!value) return;
      const rewritten = rewriteSrcset(value, proxyOrigin, targetOrigin);
      if (rewritten) element.setAttribute("srcset", rewritten);
    },
  };
}

/**
 * <base href> 改写器
 */
function baseHandler(proxyOrigin: string, targetOrigin: string) {
  return {
    element(element: Element) {
      const href = element.getAttribute("href");
      if (href) {
        const rewritten = rewriteURL(href, proxyOrigin, targetOrigin);
        if (rewritten) element.setAttribute("href", rewritten);
      }
    },
  };
}

/**
 * 用 HTMLRewriter 流式改写页面中的 URL
 */
function rewriteHTML(
  body: ReadableStream<Uint8Array> | null,
  proxyOrigin: string,
  targetOrigin: string,
): ReadableStream<Uint8Array> | null {
  if (!body) return null;

  const rewriter = new HTMLRewriter()
    // href
    .on("a[href]", urlHandler("href", proxyOrigin, targetOrigin))
    .on("link[href]", urlHandler("href", proxyOrigin, targetOrigin))
    .on("area[href]", urlHandler("href", proxyOrigin, targetOrigin))
    // src
    .on("img[src]", urlHandler("src", proxyOrigin, targetOrigin))
    .on("script[src]", urlHandler("src", proxyOrigin, targetOrigin))
    .on("iframe[src]", urlHandler("src", proxyOrigin, targetOrigin))
    .on("embed[src]", urlHandler("src", proxyOrigin, targetOrigin))
    .on("video[src]", urlHandler("src", proxyOrigin, targetOrigin))
    .on("audio[src]", urlHandler("src", proxyOrigin, targetOrigin))
    .on("source[src]", urlHandler("src", proxyOrigin, targetOrigin))
    .on("track[src]", urlHandler("src", proxyOrigin, targetOrigin))
    // srcset
    .on("img[srcset]", srcsetHandler(proxyOrigin, targetOrigin))
    .on("source[srcset]", srcsetHandler(proxyOrigin, targetOrigin))
    // 其他
    .on("video[poster]", urlHandler("poster", proxyOrigin, targetOrigin))
    .on("form[action]", urlHandler("action", proxyOrigin, targetOrigin))
    .on("object[data]", urlHandler("data", proxyOrigin, targetOrigin))
    .on("base[href]", baseHandler(proxyOrigin, targetOrigin));

  return rewriter.transform(new Response(body)).body;
}

// ─── 代理请求（手动跟随重定向 + 循环检测）──

async function doProxy(
  targetURL: string,
  request: Request,
  maxRedirects: number = 10,
): Promise<Response> {
  const visited = new Set<string>();
  let currentURL = targetURL;

  for (let i = 0; i < maxRedirects; i++) {
    if (visited.has(currentURL)) {
      return errorResponse(508, `检测到重定向循环: ${currentURL}`, request);
    }
    visited.add(currentURL);

    const forwardedHeaders = filterHeaders(request.headers);
    delete forwardedHeaders["host"];
    forwardedHeaders[INTERNAL_MARKER] = "1";

    const proxyRequest = new Request(currentURL, {
      method: request.method,
      headers: forwardedHeaders,
      body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
      redirect: "manual",
    });

    let response: Response;
    try {
      response = await fetch(proxyRequest);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResponse(502, `代理请求失败: ${message}`, request);
    }

    if (response.status < 300 || response.status >= 400) {
      return response;
    }

    const location = response.headers.get("Location");
    if (!location) return response;

    currentURL = new URL(location, currentURL).toString();
  }

  return errorResponse(508, `超过最大重定向次数 (${maxRedirects})`, request);
}

// ═══════════════════════════════════════════════
//  Worker 入口
// ═══════════════════════════════════════════════

export default {
  async fetch(request: Request): Promise<Response> {
    const corsRespHeaders = corsHeaders(request);

    // ── 内部标记：Worker 自己的子请求，直接放行 ──
    if (request.headers.get(INTERNAL_MARKER) === "1") {
      return fetch(request);
    }

    // ── OPTIONS 预检请求 ──
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsRespHeaders,
      });
    }

    // ── 提取目标 URL ──
    const targetURL = extractTargetURL(request);
    if (!targetURL) {
      return errorResponse(
        400,
        "缺少目标 URL。请通过 ?url= 查询参数或 X-Proxy-Target 请求头指定。",
        request,
      );
    }

    let parsedTarget: URL;
    try {
      parsedTarget = new URL(targetURL);
    } catch {
      return errorResponse(400, `无效的目标 URL: ${targetURL}`, request);
    }

    const proxyOrigin = new URL(request.url).origin;
    const targetOrigin = parsedTarget.origin;

    // ── 发起代理请求 ──
    const response = await doProxy(parsedTarget.toString(), request);

    // ── 构建响应头 ──
    const responseHeaders = new Headers();
    response.headers.forEach((value, key) => {
      if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
        responseHeaders.set(key, value);
      }
    });

    for (const [key, value] of Object.entries(corsRespHeaders)) {
      responseHeaders.set(key, value);
    }
    responseHeaders.set("Access-Control-Expose-Headers", "*");

    // ── 如果是 HTML，用 HTMLRewriter 流式改写页面中的 URL ──
    const contentType = response.headers.get("Content-Type") || "";
    let body = response.body;
    if (contentType.includes("text/html")) {
      body = rewriteHTML(body, proxyOrigin, targetOrigin);
    }

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  },
};
