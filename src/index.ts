/**
 * Cloudflare Worker 跨域透明代理
 *
 * 使用方式：
 *   GET  /?url=https://example.com/api/data
 *   POST /?url=https://example.com/upload  (带 body)
 *
 * 浏览器 fetch 效果与直接访问目标 URL 一致。
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

    // 标记为内部请求，防止 Worker 重复拦截
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
    if (!location) {
      return response;
    }

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
      // 移除标记后直接传给源站，不再走代理逻辑
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

    // ── 发起代理请求 ──
    const response = await doProxy(parsedTarget.toString(), request);

    // ── 构建响应（过滤 hop-by-hop 响应头 + 追加 CORS 头）──
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

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  },
};
