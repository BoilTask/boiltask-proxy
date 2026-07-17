/**
 * Cloudflare Worker 跨域透明代理
 *
 * 使用方式：
 *   GET  /?url=https://example.com/api/data
 *   POST /?url=https://example.com/upload  (带 body)
 *
 * 浏览器 fetch 效果与直接访问目标 URL 一致。
 * - HTML 静态属性 URL 自动改写
 * - JS 动态 API（fetch/XHR/history/open 等）也自动拦截改写
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
    return `${proxyOrigin}/?url=${encodeURIComponent(absolute)}`;
  } catch {
    return null;
  }
}

function rewriteSrcset(raw: string, proxyOrigin: string, targetOrigin: string): string | null {
  if (!raw) return null;

  const parts = raw.split(",").map((entry) => {
    const trimmed = entry.trim();
    const match = trimmed.match(/^(\S+)(\s+.+)?$/);
    if (!match) return entry;

    const rewritten = rewriteURL(match[1], proxyOrigin, targetOrigin);
    if (!rewritten) return entry;

    return match[2] ? `${rewritten}${match[2]}` : rewritten;
  });

  const result = parts.join(", ");
  return result !== raw ? result : null;
}

// ─── JS Shim：拦截浏览器运行时 API ───

function jsShim(proxyOrigin: string, targetOrigin: string): string {
  return `(function(){
var P="${proxyOrigin}",T="${targetOrigin}";
function R(u){
  if(!u||/^(#|javascript:|mailto:|tel:|data:|blob:|about:)/i.test(u))return u;
  try{var a=new URL(u,T).toString();return P+"/?url="+encodeURIComponent(a);}
  catch(e){return u;}
}
function S(p,n,f){
  try{var d=Object.getOwnPropertyDescriptor(p,n);if(!d||!d.configurable)return;var o=d.set,g=d.get;Object.defineProperty(p,n,{get:g,set:function(v){o.call(this,f?f(v):v)},configurable:!0});}
  catch(e){}
}

// 1. fetch()
var _f=window.fetch;
window.fetch=function(i,o){
  if(typeof i==="string")i=R(i);
  else if(i instanceof Request)try{i=new Request(R(i.url),i);}catch(e){}
  return _f.call(this,i,o);
};
window.fetch.toString=function(){return _f.toString();};

// 2. XMLHttpRequest
var _x=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(m,u){return _x.apply(this,[m,R(u)].concat([].slice.call(arguments,2)));};

// 3. history.pushState / replaceState
var _h={ps:history.pushState,rs:history.replaceState};
history.pushState=function(s,t,u){return _h.ps.apply(this,u?[s,t,R(u)]:[s,t]);};
history.replaceState=function(s,t,u){return _h.rs.apply(this,u?[s,t,R(u)]:[s,t]);};

// 4. window.open
var _wo=window.open;
window.open=function(u,n,f){return _wo.call(this,R(u),n,f);};

// 5. EventSource
if(window.EventSource){
  var _es=window.EventSource;
  window.EventSource=function(u,c){return new _es(R(u),c);};
  window.EventSource.prototype=_es.prototype;
  window.EventSource.CONNECTING=_es.CONNECTING;
  window.EventSource.OPEN=_es.OPEN;
  window.EventSource.CLOSED=_es.CLOSED;
}

// 6. WebSocket
if(window.WebSocket){
  var _ws=window.WebSocket;
  window.WebSocket=function(u,p){return new _ws(R(u),p);};
  window.WebSocket.prototype=_ws.prototype;
  window.WebSocket.CONNECTING=_ws.CONNECTING;
  window.WebSocket.OPEN=_ws.OPEN;
  window.WebSocket.CLOSING=_ws.CLOSING;
  window.WebSocket.CLOSED=_ws.CLOSED;
}

// 7. location.assign / replace
try{
  var _la=location.assign.bind(location);
  var _lr=location.replace.bind(location);
  location.assign=function(u){return _la(R(u));};
  location.replace=function(u){return _lr(R(u));};
}catch(e){}

// 8. Element 属性 setter（拦截 img.src = "..." 等动态赋值）
var props={
  HTMLImageElement:["src","srcset"],HTMLScriptElement:["src"],
  HTMLLinkElement:["href"],HTMLAnchorElement:["href"],
  HTMLIFrameElement:["src"],HTMLEmbedElement:["src"],
  HTMLVideoElement:["src","poster"],HTMLAudioElement:["src"],
  HTMLSourceElement:["src","srcset"],HTMLTrackElement:["src"],
  HTMLFormElement:["action"],HTMLObjectElement:["data"]
};
Object.keys(props).forEach(function(t){
  var e=window[t];if(!e||!e.prototype)return;
  props[t].forEach(function(n){
    n==="srcset"?S(e.prototype,n,function(v){return v.split(",").map(function(e){var t=e.trim(),m=t.match(/^(\\S+)(\\s+.+)?$/);if(!m)return e;var r=R(m[1]);return m[2]?r+m[2]:r;}).join(",");}):S(e.prototype,n,R);
  });
});

// 9. setAttribute / setAttributeNS
var ATTRS=["href","src","action","data","poster"];
var _sa=Element.prototype.setAttribute;
Element.prototype.setAttribute=function(n,v){
  if(ATTRS.indexOf(n.toLowerCase())!==-1)v=R(v);
  return _sa.call(this,n,v);
};
var _san=Element.prototype.setAttributeNS;
Element.prototype.setAttributeNS=function(ns,n,v){
  if(ATTRS.indexOf(n.toLowerCase())!==-1)v=R(v);
  return _san.call(this,ns,n,v);
};

})();`;
}

// ─── HTMLRewriter 处理器 ───

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
 * 注入 JS shim 到 <head> 最前面（在所有脚本之前执行）
 */
function injectShim(proxyOrigin: string, targetOrigin: string) {
  const shim = jsShim(proxyOrigin, targetOrigin);
  return {
    element(element: Element) {
      element.prepend(`<script>${shim}<\/script>`, { html: true });
    },
  };
}

/**
 * 用 HTMLRewriter 流式改写页面中的 URL + 注入 shim
 */
function rewriteHTML(
  body: ReadableStream<Uint8Array> | null,
  proxyOrigin: string,
  targetOrigin: string,
): ReadableStream<Uint8Array> | null {
  if (!body) return null;

  const rewriter = new HTMLRewriter()
    // 注入 JS shim（最先执行）
    .on('head', injectShim(proxyOrigin, targetOrigin))
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

    // ── 如果是 HTML，用 HTMLRewriter 流式改写页面中的 URL + 注入 shim ──
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
