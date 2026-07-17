/**
 * Cloudflare Worker 跨域透明代理
 *
 * 使用方式：
 *   GET  /proxy?url=https://example.com/api/data
 *   POST /proxy?url=https://example.com/upload  (带 body)
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

// ─── 提取目标 URL ───

function extractTargetURL(request: Request): string | null {
  const url = new URL(request.url);

  // 方式 1：查询参数 ?url=...
  const queryTarget = url.searchParams.get("url");
  if (queryTarget) {
    return queryTarget;
  }

  // 方式 2：自定义请求头 X-Proxy-Target
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
    if (!HOP_BY_HOP_HEADERS.has(lower)) {
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

// ═══════════════════════════════════════════════
//  Worker 入口
// ═══════════════════════════════════════════════

export default {
  async fetch(request: Request): Promise<Response> {
    const corsRespHeaders = corsHeaders(request);

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

    // ── 构建转发请求 ──
    const forwardedHeaders = filterHeaders(request.headers);
    // 清除 Host（让 fetch 自动设置目标 Host）
    delete forwardedHeaders["host"];

    const proxyRequest = new Request(parsedTarget.toString(), {
      method: request.method,
      headers: forwardedHeaders,
      body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
    });

    // ── 发起请求 ──
    let response: Response;
    try {
      response = await fetch(proxyRequest);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResponse(502, `代理请求失败: ${message}`, request);
    }

    // ── 构建响应（过滤 hop-by-hop 响应头 + 追加 CORS 头）──
    const responseHeaders = new Headers();

    response.headers.forEach((value, key) => {
      if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
        responseHeaders.set(key, value);
      }
    });

    // 附加 CORS 头
    for (const [key, value] of Object.entries(corsRespHeaders)) {
      responseHeaders.set(key, value);
    }

    // 暴露所有响应头给浏览器
    responseHeaders.set("Access-Control-Expose-Headers", "*");

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  },
};
