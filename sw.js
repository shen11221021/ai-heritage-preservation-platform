const scopeUrl = new URL(self.registration.scope);
const appUrl = new URL("app.zip", scopeUrl).toString();
const apiDataUrl = new URL("api-demo-data.json", scopeUrl).toString();
const archiveCacheUrl = new URL("__heritage_demo_archives__", scopeUrl).toString();
const archiveCacheName = "heritage-public-demo-v1";
let fileMapPromise;
let apiDataPromise;
let runtimeArchives;

function u16(view, offset) {
  return view.getUint16(offset, true);
}

function u32(view, offset) {
  return view.getUint32(offset, true);
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unzip(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const minimum = Math.max(0, bytes.length - 65557);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (u32(view, offset) === 0x06054b50) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new Error("ZIP end record not found");

  const count = u16(view, end + 10);
  const centralOffset = u32(view, end + 16);
  const decoder = new TextDecoder("utf-8");
  const files = new Map();
  let cursor = centralOffset;

  for (let index = 0; index < count; index += 1) {
    if (u32(view, cursor) !== 0x02014b50) throw new Error("Invalid ZIP directory");
    const method = u16(view, cursor + 10);
    const compressedSize = u32(view, cursor + 20);
    const nameLength = u16(view, cursor + 28);
    const extraLength = u16(view, cursor + 30);
    const commentLength = u16(view, cursor + 32);
    const localOffset = u32(view, cursor + 42);
    const name = decoder.decode(bytes.slice(cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;

    if (u32(view, localOffset) !== 0x04034b50) throw new Error("Invalid ZIP entry: " + name);
    const localNameLength = u16(view, localOffset + 26);
    const localExtraLength = u16(view, localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.slice(dataOffset, dataOffset + compressedSize);
    let content;
    if (method === 0) {
      content = compressed;
    } else if (method === 8) {
      content = await inflateRaw(compressed);
    } else {
      throw new Error("Unsupported ZIP compression method: " + method);
    }
    files.set(name.replace(/\\/g, "/"), content);
  }
  return files;
}

function loadFiles() {
  if (!fileMapPromise) {
    fileMapPromise = fetch(appUrl, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error("Unable to load app.zip");
        return response.arrayBuffer();
      })
      .then(unzip);
  }
  return fileMapPromise;
}

function loadApiData() {
  if (!apiDataPromise) {
    apiDataPromise = fetch(apiDataUrl, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error("Unable to load API demo data");
        return response.json();
      });
  }
  return apiDataPromise;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function staticResponse(filePath, content) {
  let output = content;
  if (filePath === "01_平台前端/index.html") {
    const html = new TextDecoder("utf-8").decode(content);
    const marker = '<script src="index.js"></script>';
    const wrapper = [
      '<script>' +
      'const __nativeFetch = window.fetch.bind(window);' +
      'window.fetch = function(input, init) {' +
      'if (typeof input === "string" && input.indexOf("/api/") === 0) {' +
      'input = "../" + input.slice(1);' +
      '}' +
      'return __nativeFetch(input, init);' +
      '};' +
      '</script>' + marker
    ];
    if (html.includes(marker)) {
      output = new TextEncoder().encode(html.replace(marker, wrapper));
    }
  }
  return new Response(output, {
    status: 200,
    headers: {
      "Content-Type": contentType(filePath),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function contentType(path) {
  const extension = path.split(".").pop().toLowerCase();
  return {
    html: "text/html; charset=utf-8",
    css: "text/css; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    json: "application/json; charset=utf-8",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    svg: "image/svg+xml",
    glb: "model/gltf-binary",
    gltf: "model/gltf+json",
    txt: "text/plain; charset=utf-8",
    md: "text/markdown; charset=utf-8",
    bat: "text/plain; charset=utf-8"
  }[extension] || "application/octet-stream";
}

function nowIso() {
  return new Date().toISOString();
}

function siteNameMap(apiData) {
  const cases = apiData.system_status?.data?.cases || [];
  const keys = ["lie-shishan", "qingxiang-wall", "langyu-caomaoshan"];
  return Object.fromEntries(keys.map((key, index) => [key, cases[index]?.name || key]));
}

async function readArchives(apiData) {
  if (runtimeArchives) return runtimeArchives;
  try {
    const cache = await caches.open(archiveCacheName);
    const stored = await cache.match(archiveCacheUrl);
    if (stored) {
      runtimeArchives = await stored.json();
      return runtimeArchives;
    }
  } catch (error) {
    console.warn("Archive cache read failed.", error);
  }
  runtimeArchives = clone(apiData.archives.data || []);
  return runtimeArchives;
}

async function writeArchives(archives) {
  runtimeArchives = archives;
  try {
    const cache = await caches.open(archiveCacheName);
    await cache.put(
      archiveCacheUrl,
      new Response(JSON.stringify(archives), {
        headers: { "Content-Type": "application/json; charset=utf-8" }
      })
    );
  } catch (error) {
    console.warn("Archive cache write failed.", error);
  }
}

async function handleBrowserApi(request) {
  const apiData = await loadApiData();
  const url = new URL(request.url);
  const basePath = scopeUrl.pathname.endsWith("/") ? scopeUrl.pathname : scopeUrl.pathname + "/";
  const path = url.pathname.startsWith(basePath)
    ? "/" + url.pathname.slice(basePath.length)
    : url.pathname;
  const method = request.method.toUpperCase();

  if (method === "GET") {
    if (path === "/api/health" || path === "/api/system/status") {
      const payload = clone(apiData.system_status);
      payload.data.status = "online";
      payload.data.server_time = nowIso();
      payload.data.public_url = scopeUrl.origin + scopeUrl.pathname;
      payload.data.runtime_mode = "public_browser_demo";
      payload.data.database.storage = "Browser demo store";
      return jsonResponse(payload);
    }
    if (path === "/api/ai/status") {
      const payload = clone(apiData.ai_status);
      payload.data.runtime_mode = "public_browser_demo";
      return jsonResponse(payload);
    }
    if (path === "/api/agent/manifest") return jsonResponse(clone(apiData.manifest));
    if (path === "/api/agent/metrics") return jsonResponse(clone(apiData.metrics));
    if (path === "/api/showcase/cases") return jsonResponse(clone(apiData.cases));
    if (path === "/api/cases" || path === "/api/sites") {
      return jsonResponse({ ok: true, data: clone(apiData.system_status.data.cases || []) });
    }
    if (path === "/api/archives") {
      const archives = await readArchives(apiData);
      return jsonResponse({ ok: true, data: clone(archives) });
    }
    if (path === "/api/export/archives") {
      const archives = await readArchives(apiData);
      return jsonResponse({ ok: true, exported_at: nowIso(), data: clone(archives) });
    }
    const archiveMatch = path.match(/^\/api\/archives\/(\d+)$/);
    if (archiveMatch) {
      const archives = await readArchives(apiData);
      const archive = archives.find((item) => Number(item.id) === Number(archiveMatch[1]));
      return archive
        ? jsonResponse({ ok: true, data: clone(archive) })
        : jsonResponse({ ok: false, error: "Archive not found" }, 404);
    }
    return jsonResponse({ ok: false, error: "API route not found" }, 404);
  }

  if (method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  let body = {};
  try {
    body = await request.json();
  } catch (error) {
    return jsonResponse({ ok: false, error: "Invalid JSON body" }, 400);
  }

  if (path === "/api/showcase/verify") {
    const payload = clone(apiData.verify);
    payload.data.case_id = String(body.case_id || payload.data.case_id || "").toUpperCase();
    return jsonResponse(payload);
  }
  if (path === "/api/plan") return jsonResponse(clone(apiData.plan));
  if (path === "/api/knowledge/search") {
    const payload = clone(apiData.knowledge);
    payload.data.query = String(body.query || payload.data.query || "");
    payload.data.generated_at = nowIso();
    return jsonResponse(payload);
  }
  if (path === "/api/agent/run") {
    const payload = clone(apiData.agent);
    payload.data.site_key = String(body.site_key || payload.data.site_key || "lie-shishan");
    payload.data.goal = String(body.goal || payload.data.goal || "");
    payload.data.query = String(body.query || payload.data.query || "");
    payload.data.generated_at = nowIso();
    return jsonResponse(payload);
  }
  if (path === "/api/ai/generate") {
    const payload = clone(apiData.generate);
    payload.data.generated_at = nowIso();
    return jsonResponse(payload);
  }
  if (path === "/api/ai/self-test") {
    const payload = clone(apiData.selftest);
    payload.data.generated_at = nowIso();
    return jsonResponse(payload);
  }
  if (path === "/api/archives") {
    const archives = await readArchives(apiData);
    const nextId = archives.reduce((maximum, item) => Math.max(maximum, Number(item.id) || 0), 0) + 1;
    const timestamp = nowIso();
    const names = siteNameMap(apiData);
    const archive = {
      id: nextId,
      site_key: String(body.site_key || "lie-shishan"),
      title: String(body.title || "").trim(),
      summary: String(body.summary || "").trim(),
      source: String(body.source || "").trim(),
      review_status: "pending",
      created_by: String(body.created_by || "").trim(),
      created_at: timestamp,
      updated_at: timestamp,
      site_name: names[body.site_key] || String(body.site_key || ""),
      review_status_label: "Pending review",
      reviews: []
    };
    if (!archive.title || !archive.summary || !archive.source || !archive.created_by) {
      return jsonResponse({ ok: false, error: "Missing required archive fields" }, 400);
    }
    archives.unshift(archive);
    await writeArchives(archives);
    return jsonResponse({ ok: true, data: clone(archive) }, 201);
  }
  const reviewMatch = path.match(/^\/api\/archives\/(\d+)\/reviews$/);
  if (reviewMatch) {
    const archives = await readArchives(apiData);
    const archive = archives.find((item) => Number(item.id) === Number(reviewMatch[1]));
    if (!archive) return jsonResponse({ ok: false, error: "Archive not found" }, 404);
    const decision = String(body.decision || "");
    if (!["pending", "approved", "changes_requested", "rejected"].includes(decision)) {
      return jsonResponse({ ok: false, error: "Invalid review decision" }, 400);
    }
    const timestamp = nowIso();
    archive.review_status = decision;
    archive.updated_at = timestamp;
    archive.review_status_label = {
      pending: "Pending review",
      approved: "Approved",
      changes_requested: "Changes requested",
      rejected: "Rejected"
    }[decision];
    archive.reviews = archive.reviews || [];
    archive.reviews.unshift({
      id: archive.reviews.length + 1,
      archive_id: archive.id,
      decision,
      reviewer: String(body.reviewer || "").trim(),
      comment: String(body.comment || "").trim(),
      created_at: timestamp
    });
    await writeArchives(archives);
    return jsonResponse({ ok: true, data: clone(archive) });
  }

  return jsonResponse({ ok: false, error: "API route not found" }, 404);
}

self.addEventListener("install", (event) => {
  event.waitUntil(Promise.all([loadFiles(), loadApiData()]).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;

  const basePath = scopeUrl.pathname.endsWith("/") ? scopeUrl.pathname : scopeUrl.pathname + "/";
  const relativePath = decodeURIComponent(requestUrl.pathname.slice(basePath.length));
  if (relativePath.startsWith("api/")) {
    event.respondWith(handleBrowserApi(event.request));
    return;
  }
  if (event.request.method !== "GET") return;

  event.respondWith((async () => {
    const files = await loadFiles();
    let filePath = relativePath;
    if (!filePath || filePath === "index.html") {
      filePath = "01_平台前端/index.html";
    }
    const content = files.get(filePath);
    if (!content) {
      return new Response("Not found", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }
    return staticResponse(filePath, content);
  })());
});
