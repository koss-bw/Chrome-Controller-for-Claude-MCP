// API discovery and reverse engineering, for the api_* tools.
//
// Loaded into the service worker with importScripts() from background.js, which
// keeps this out of that already-large file and — more usefully — lets the pure
// half be unit-tested in a bare node:vm with no chrome mock at all.
//
// Why this exists alongside read_network_requests: that tool records url,
// method, status and mimeType, which is enough to see that a page called an API
// and nothing like enough to reconstruct the call. Reproducing a request needs
// the real headers (the ones the browser adds, not the ones the page passed),
// the request body, the response body, and the auth material — none of which the
// old capture keeps, and none of which survives a service-worker eviction.
//
// Two design decisions worth knowing before reading:
//
//  1. WRITE-THROUGH. Every completed request is flushed to disk as its own file
//     within a few hundred milliseconds. MV3 evicts this worker after ~30s idle,
//     so anything held in memory for the length of a crawl is already lost. What
//     stays in memory is a compact index (one small object per request), which
//     is also mirrored to chrome.storage.session so an eviction mid-crawl costs
//     us nothing but the requests still in flight.
//
//  2. NO READ-BACK. The native host writes files; it does not read them, and
//     host->extension native messages are capped at 1MB anyway, so a 3MB bundle
//     could not come back in one piece. So the analysis tools never re-read what
//     they wrote: api_spec works from the in-memory index (schemas are merged
//     incrementally at flush time) and api_scan_source works from the sources
//     api_fetch_source is still holding. The files on disk are the deliverable,
//     not our working set.
(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Dependencies, injected by background.js so this file can be loaded standalone.
  // ---------------------------------------------------------------------------
  let deps = {
    cdp: async () => { throw new Error("ApiMap not initialized"); },
    ensureAttached: async () => {},
    ensureDomain: async () => {},
    apiWrite: async () => { throw new Error("ApiMap not initialized"); }
  };

  function init(d) {
    deps = Object.assign({}, deps, d);
  }

  // ===========================================================================
  // PURE HALF — no chrome.*, no deps, no I/O. Everything here is a function of
  // its arguments, which is the whole point: this is the part that can be wrong
  // in subtle ways, so it is the part that gets unit tests.
  // ===========================================================================

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const HEX_RE = /^[0-9a-f]{12,}$/i;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

  // Guess whether one path segment is an identifier rather than a route name.
  // Returns null for "this is part of the route", or a kind string.
  function segmentKind(seg) {
    if (!seg) return null;
    if (/^\d+$/.test(seg)) return "integer";
    if (UUID_RE.test(seg)) return "uuid";
    if (ULID_RE.test(seg)) return "ulid";
    if (DATE_RE.test(seg)) return "date";
    if (HEX_RE.test(seg)) return "hash";
    // Mixed-case-and-digits blobs of some length are ids (base64 ids, nanoids,
    // Stripe-style prefixed keys). Plain words are not, however long.
    if (seg.length >= 12 && /\d/.test(seg) && /[A-Za-z]/.test(seg) && !/^[a-z][a-z-]*$/.test(seg)) return "opaque";
    return null;
  }

  function singularize(word) {
    if (/ies$/i.test(word)) return word.replace(/ies$/i, "y");
    if (/(s|sh|ch|x|z)es$/i.test(word)) return word.replace(/es$/i, "");
    // status, analysis, address, class: the trailing s is not a plural, and
    // "statu"/"analysi" would be a silly name to put in generated code.
    if (/(ss|us|is)$/i.test(word)) return word;
    if (/s$/i.test(word)) return word.replace(/s$/i, "");
    return word;
  }

  function camel(str) {
    return String(str)
      .replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ""))
      .replace(/^(.)/, (m) => m.toLowerCase());
  }

  // Turn a concrete pathname into an OpenAPI path template plus the parameters
  // it implies. Parameters are named after the segment in front of them —
  // /users/42 gives {userId}, not {id} — because the generated Python reads far
  // better that way, and OpenAPI requires the names be unique within one path.
  function templatePath(pathname) {
    const raw = String(pathname || "/");
    const segs = raw.split("/");
    const params = [];
    const used = Object.create(null);
    const out = segs.map((seg, i) => {
      const kind = segmentKind(seg);
      if (!kind) return seg;
      const prev = segs[i - 1];
      let base = prev && !segmentKind(prev) ? camel(singularize(prev)) + "Id" : "id";
      if (used[base]) base = base + ++used[base];
      else used[base] = 1;
      params.push({ name: base, kind, example: seg });
      return "{" + base + "}";
    });
    return { template: out.join("/") || "/", params };
  }

  // ---- JSON Schema inference -------------------------------------------------

  // A path that already carries {placeholders}. Every one of them has to end up
  // in params as well as in the template: an OpenAPI path parameter that is not
  // declared makes the whole document invalid, and a client generated from it
  // has no idea what to substitute.
  function declaredTemplate(pathname) {
    const params = [];
    const used = Object.create(null);
    const template = String(pathname).replace(/\{([^}/]*)\}/g, (m, raw) => {
      let name = camel(String(raw || "").replace(/[^A-Za-z0-9_]+/g, " ").trim()) || "param";
      if (/^\d/.test(name)) name = "p" + name;
      if (used[name]) name = name + ++used[name];
      else used[name] = 1;
      params.push({ name, kind: /id$/i.test(name) ? "opaque" : "opaque", declared: true });
      return "{" + name + "}";
    });
    return { template, params };
  }

  function primitiveSchema(v) {
    if (v === null) return { type: "null" };
    switch (typeof v) {
      case "boolean":
        return { type: "boolean" };
      case "number":
        return Number.isInteger(v) ? { type: "integer", example: v } : { type: "number", example: v };
      case "string": {
        const s = { type: "string", example: v.length > 80 ? v.slice(0, 80) + "…" : v };
        if (UUID_RE.test(v)) s.format = "uuid";
        else if (/^\d{4}-\d{2}-\d{2}T[\d:.]+/.test(v)) s.format = "date-time";
        else if (DATE_RE.test(v)) s.format = "date";
        else if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) s.format = "email";
        else if (/^https?:\/\//.test(v)) s.format = "uri";
        return s;
      }
      default:
        return {};
    }
  }

  function inferJsonSchema(value, depth) {
    const d = typeof depth === "number" ? depth : 0;
    if (d > 8) return {};
    if (Array.isArray(value)) {
      let items = null;
      // Sample the head: a 5000-element array tells us nothing the first few
      // elements didn't, and merging all of them is the slow path for nothing.
      for (const el of value.slice(0, 20)) {
        const s = inferJsonSchema(el, d + 1);
        items = items ? mergeSchema(items, s) : s;
      }
      return items ? { type: "array", items } : { type: "array" };
    }
    if (value && typeof value === "object") {
      const properties = {};
      const required = [];
      for (const k of Object.keys(value)) {
        properties[k] = inferJsonSchema(value[k], d + 1);
        if (value[k] !== null && value[k] !== undefined) required.push(k);
      }
      const out = { type: "object", properties };
      if (required.length) out.required = required;
      return out;
    }
    return primitiveSchema(value);
  }

  // Merge two schemas inferred from different samples of the same thing. A key
  // present in one sample and absent from another stops being required — that
  // is the single most useful thing this function does, since it is how optional
  // fields get discovered without anyone documenting them.
  function mergeSchema(a, b) {
    if (!a) return b;
    if (!b) return a;
    if (a.type === "null" && b.type !== "null") return Object.assign({}, b, { nullable: true });
    if (b.type === "null" && a.type !== "null") return Object.assign({}, a, { nullable: true });
    if (a.type === "integer" && b.type === "number") return Object.assign({}, b, { nullable: a.nullable || b.nullable });
    if (a.type === "number" && b.type === "integer") return Object.assign({}, a, { nullable: a.nullable || b.nullable });
    if (a.type !== b.type) {
      const variants = [].concat(a.oneOf || [a], b.oneOf || [b]);
      const seen = Object.create(null);
      const oneOf = variants.filter((v) => {
        const k = v.type || "any";
        if (seen[k]) return false;
        seen[k] = 1;
        return true;
      });
      return oneOf.length === 1 ? oneOf[0] : { oneOf };
    }
    if (a.type === "object") {
      const properties = Object.assign({}, a.properties);
      for (const k of Object.keys(b.properties || {})) {
        properties[k] = mergeSchema(a.properties && a.properties[k], b.properties[k]);
      }
      const ar = a.required || [];
      const br = b.required || [];
      const required = ar.filter((k) => br.indexOf(k) !== -1);
      const out = { type: "object", properties };
      if (required.length) out.required = required;
      if (a.nullable || b.nullable) out.nullable = true;
      return out;
    }
    if (a.type === "array") {
      const out = { type: "array" };
      const items = mergeSchema(a.items, b.items);
      if (items) out.items = items;
      if (a.nullable || b.nullable) out.nullable = true;
      return out;
    }
    const out = Object.assign({}, a);
    if (b.format && !out.format) out.format = b.format;
    if (a.format && b.format && a.format !== b.format) delete out.format;
    if (a.nullable || b.nullable) out.nullable = true;
    return out;
  }

  // ---- Static source mining --------------------------------------------------

  const ASSET_RE = /\.(png|jpe?g|gif|svg|webp|ico|css|woff2?|ttf|eot|mp4|webm|map)(\?|$)/i;

  // Paths worth reporting. A bundle is full of string literals that merely
  // contain a slash; what we want is something that could be an HTTP route.
  function looksLikeRoute(v) {
    if (!v || v.length < 2 || v.length > 300) return false;
    if (ASSET_RE.test(v)) return false;
    if (/^\/\//.test(v)) return false; // protocol-relative asset host, usually a CDN
    if (/\s/.test(v)) return false;
    if (/^https?:\/\//.test(v)) return true;
    if (v[0] !== "/") return false;
    if (/^\/[A-Za-z0-9_{}$:.-]*$/.test(v) && v.length < 4) return false; // "/", "/a"
    return /^\/[A-Za-z0-9_\-{}$/:.%]+$/.test(v);
  }

  function scoreFinding(f) {
    let s = 0;
    if (/\/(api|rest|graphql|gql)(\/|$)/i.test(f.value)) s += 5;
    if (/\/v\d+(\/|$)/.test(f.value)) s += 3;
    if (f.method) s += 3;
    if (f.kind === "call-site") s += 2;
    if (f.kind === "graphql") s += 4;
    if (f.kind === "template") s += 1;
    if (f.kind === "client-route") s -= 4;
    if (f.kind === "openapi-doc") s += 10;
    if (/\{|\$\{/.test(f.value)) s += 1;
    if (/\.(html?|txt|xml)$/i.test(f.value)) s -= 2;
    return s;
  }

  function contextAt(source, index, span) {
    const w = span || 70;
    const from = Math.max(0, index - w);
    const to = Math.min(source.length, index + w);
    return (from > 0 ? "…" : "") + source.slice(from, to).replace(/\s+/g, " ") + (to < source.length ? "…" : "");
  }

  // Mine one JS source for anything that looks like an API endpoint. This is
  // deliberately a set of regexes rather than a parser: bundles are minified,
  // frequently not valid standalone modules, and we want candidates to verify
  // with api_probe, not a proof. Precision is traded for recall on purpose.
  function mineSourceForEndpoints(source, fileName) {
    const src = String(source || "");
    const file = fileName || "?";
    const out = [];
    const push = (kind, value, index, extra) => {
      if (!value) return;
      out.push(Object.assign({ kind, value, file, index, context: contextAt(src, index) }, extra || {}));
    };

    // 1. Quoted absolute paths and URLs.
    let m;
    const quoted = /(['"])((?:https?:\/\/|\/)[^'"\\\s]{1,300}?)\1/g;
    while ((m = quoted.exec(src))) {
      if (looksLikeRoute(m[2])) push("literal", m[2], m.index);
    }

    // 2. Template literals with interpolation — `/api/users/${id}/orders`. The
    //    interpolation is what makes these valuable: it marks the path
    //    parameter for us, so it is normalized to {param} rather than dropped.
    const tpl = /`((?:https?:\/\/|\/)[^`\\]{0,300})`/g;
    while ((m = tpl.exec(src))) {
      const norm = m[1].replace(/\$\{[^}]*\}/g, "{param}");
      if (norm.indexOf("{param}") !== -1 && looksLikeRoute(norm)) push("template", norm, m.index);
    }

    // 3. Call sites, which give us the method as well as the path.
    const calls = [
      { re: /\baxios\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(\s*[`'"]([^`'"]{1,300})[`'"]/gi, method: 1, url: 2 },
      { re: /\$\s*\.\s*(get|post)\s*\(\s*[`'"]([^`'"]{1,300})[`'"]/gi, method: 1, url: 2 },
      { re: /\.\s*open\s*\(\s*[`'"](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)[`'"]\s*,\s*[`'"]([^`'"]{1,300})[`'"]/gi, method: 1, url: 2 },
      { re: /\bfetch\s*\(\s*[`'"]([^`'"]{1,300})[`'"]/gi, method: null, url: 1 },
      { re: /\brequest\s*\(\s*\{\s*(?:method\s*:\s*[`'"](\w+)[`'"][^}]*?)?url\s*:\s*[`'"]([^`'"]{1,300})[`'"]/gi, method: 1, url: 2 }
    ];
    for (const c of calls) {
      c.re.lastIndex = 0;
      while ((m = c.re.exec(src))) {
        const value = m[c.url].replace(/\$\{[^}]*\}/g, "{param}");
        if (!looksLikeRoute(value)) continue;
        const method = c.method && m[c.method] ? m[c.method].toUpperCase() : null;
        push("call-site", value, m.index, method ? { method } : {});
      }
    }
    // A fetch whose method is set in the options object a few characters later.
    const fetchWithMethod = /\bfetch\s*\([^)]{0,200}?method\s*:\s*[`'"](\w+)[`'"]/gi;
    while ((m = fetchWithMethod.exec(src))) {
      push("call-site-method", m[1].toUpperCase(), m.index, { method: m[1].toUpperCase() });
    }

    // 4. GraphQL. The operations are the API surface; the endpoint is usually a
    //    single /graphql that traffic capture already found.
    const gql = /\b(query|mutation|subscription)\s+([A-Za-z_]\w*)\s*[({]/g;
    while ((m = gql.exec(src))) {
      push("graphql", m[1] + " " + m[2], m.index, { operation: m[2], operationType: m[1] });
    }
    const opName = /operationName\s*[:=]\s*[`'"](\w+)[`'"]/g;
    while ((m = opName.exec(src))) push("graphql", "operationName " + m[1], m.index, { operation: m[1] });

    // 5. A machine-readable spec is worth more than everything above put
    //    together, so call it out loudly if the bundle mentions one.
    const spec = /[`'"]([^`'"\s]*(?:swagger|openapi)[^`'"\s]*\.(?:json|yaml|yml)|\/v\d\/api-docs[^`'"\s]*)[`'"]/gi;
    while ((m = spec.exec(src))) push("spec-document", m[1], m.index);

    // An express/vue/angular-style ":param" segment marks a client-side route
    // definition, not a server endpoint. Keep them — they describe the app's
    // page structure — but under their own kind, so the spec can leave them out.
    for (const f of out) {
      if (f.kind !== "graphql" && f.kind !== "call-site-method" && /\/:[A-Za-z_]/.test(f.value)) f.kind = "client-route";
    }

    // Dedupe on kind+value+method, keeping the first occurrence, then rank.
    const seen = Object.create(null);
    const deduped = [];
    for (const f of out) {
      const key = f.kind + " " + (f.method || "") + " " + f.value;
      if (seen[key]) {
        seen[key].count++;
        continue;
      }
      f.count = 1;
      seen[key] = f;
      deduped.push(f);
    }
    for (const f of deduped) f.score = scoreFinding(f);
    deduped.sort((a, b) => b.score - a.score || a.value.localeCompare(b.value));
    return deduped;
  }

  // ---- Catalog + OpenAPI -----------------------------------------------------

  // Fold the observed-traffic index into one entry per method+path template.
  function buildCatalog(records) {
    const byKey = Object.create(null);
    for (const r of records || []) {
      let u;
      try {
        u = new URL(r.url);
      } catch (e) {
        continue;
      }
      const t = templatePath(u.pathname);
      const key = (r.method || "GET") + " " + u.origin + t.template;
      let e = byKey[key];
      if (!e) {
        e = byKey[key] = {
          method: r.method || "GET",
          origin: u.origin,
          path: t.template,
          pathParams: t.params,
          queryParams: {},
          statuses: {},
          contentTypes: {},
          requestSchema: null,
          responseSchemas: {},
          authHeaders: {},
          observed: true,
          calls: 0,
          examples: []
        };
      }
      e.calls++;
      if (r.status) e.statuses[r.status] = (e.statuses[r.status] || 0) + 1;
      if (r.mime) e.contentTypes[r.mime] = (e.contentTypes[r.mime] || 0) + 1;
      for (const [k, v] of u.searchParams.entries()) {
        if (!e.queryParams[k]) e.queryParams[k] = { name: k, examples: [] };
        if (e.queryParams[k].examples.length < 3 && e.queryParams[k].examples.indexOf(v) === -1) {
          e.queryParams[k].examples.push(v);
        }
      }
      for (const n of Object.keys(r.authHeaders || {})) e.authHeaders[n] = true;
      if (r.reqSchema) e.requestSchema = mergeSchema(e.requestSchema, r.reqSchema);
      if (r.respSchema) {
        const bucket = String(r.status || "default");
        e.responseSchemas[bucket] = mergeSchema(e.responseSchemas[bucket], r.respSchema);
      }
      if (e.examples.length < 3) e.examples.push({ url: r.url, status: r.status, file: r.file });
      if (!e.pathParams.length && t.params.length) e.pathParams = t.params;
    }
    return Object.keys(byKey)
      .sort()
      .map((k) => byKey[k]);
  }

  // Add endpoints that only static analysis found. They are kept separate by
  // `observed: false` rather than blended in, because an unexercised endpoint
  // mined out of a bundle is a lead, not a fact — the generated client should
  // say so.
  // Two templates describe the same endpoint whatever their parameters are
  // called: the observed side names them after the route (/users/{userId}),
  // the mined side only knows there was an interpolation (/users/{param}).
  function shapeKey(method, path) {
    return method + " " + String(path).replace(/\{[^}]*\}/g, "{}");
  }

  // Only reasonably-scored candidates are promoted into the spec. A bundle
  // yields hundreds of plausible-looking strings, and a spec listing all of
  // them is worse than one listing none: it buries the endpoints that are real.
  // Everything mined is still in findings.json regardless.
  const SPEC_SCORE_FLOOR = 3;

  function mergeFindings(catalog, findings, opts) {
    const floor = opts && typeof opts.scoreFloor === "number" ? opts.scoreFloor : SPEC_SCORE_FLOOR;
    const have = Object.create(null);
    for (const e of catalog) have[shapeKey(e.method, e.path)] = e;
    const added = [];
    const held = [];
    for (const f of findings || []) {
      if (f.kind === "graphql" || f.kind === "call-site-method" || f.kind === "client-route") continue;
      if ((f.score || 0) < floor) {
        held.push(f);
        continue;
      }
      let pathname = f.value;
      let origin = null;
      if (/^https?:\/\//.test(f.value)) {
        try {
          const u = new URL(f.value);
          origin = u.origin;
          pathname = u.pathname;
        } catch (e) {
          continue;
        }
      }
      // A path can arrive already templated — {param} from a template literal in
      // a bundle, or real parameter names from a published spec. Keep those
      // names: re-templating would throw away the best information we have.
      // URL parsing percent-encodes the braces, so undo that first, or a
      // declared /widgets/{id} lands in the catalog as /widgets/%7Bid%7D.
      pathname = pathname.replace(/%7B/gi, "{").replace(/%7D/gi, "}");
      const t = /\{[^}/]*\}/.test(pathname) ? declaredTemplate(pathname) : templatePath(pathname);
      const method = f.method || "GET";
      const key = shapeKey(method, t.template);
      if (have[key]) {
        have[key].alsoFoundInSource = have[key].alsoFoundInSource || [];
        if (have[key].alsoFoundInSource.indexOf(f.file) === -1) have[key].alsoFoundInSource.push(f.file);
        continue;
      }
      const entry = {
        method,
        origin,
        path: t.template,
        pathParams: t.params,
        queryParams: {},
        statuses: {},
        contentTypes: {},
        requestSchema: null,
        responseSchemas: {},
        authHeaders: {},
        observed: false,
        foundIn: [{ file: f.file, kind: f.kind, context: f.context }],
        declared: f.declared === true,
        score: f.score,
        calls: 0,
        examples: []
      };
      have[key] = entry;
      added.push(entry);
    }
    const out = catalog.concat(added);
    out.heldBack = held.length;
    return out;
  }

  const OPENAPI_KIND_TYPES = { integer: "integer", uuid: "string", ulid: "string", date: "string", hash: "string", opaque: "string" };

  function toOpenApi(catalog, meta) {
    const info = meta || {};
    const originCounts = Object.create(null);
    for (const e of catalog) {
      if (e.origin) originCounts[e.origin] = (originCounts[e.origin] || 0) + 1 + (e.observed ? 10 : 0);
    }
    // Most-used origin first. A client needs one base URL, and a third-party
    // host that contributed a single mined string should not outrank the origin
    // every observed call actually went to.
    const servers = Object.keys(originCounts)
      .sort((a, b) => originCounts[b] - originCounts[a] || a.localeCompare(b))
      .map((url) => ({ url }));
    const paths = {};
    const securitySchemes = {};
    for (const e of catalog) {
      const item = (paths[e.path] = paths[e.path] || {});
      const parameters = [];
      for (const p of e.pathParams || []) {
        parameters.push({
          name: p.name,
          in: "path",
          required: true,
          schema: { type: OPENAPI_KIND_TYPES[p.kind] || "string" },
          example: p.example
        });
      }
      for (const k of Object.keys(e.queryParams || {})) {
        const q = e.queryParams[k];
        parameters.push({
          name: k,
          in: "query",
          required: false,
          schema: { type: "string" },
          example: q.examples && q.examples[0]
        });
      }
      const security = [];
      for (const h of Object.keys(e.authHeaders || {})) {
        const name = camel(h) || "auth";
        if (/^authorization$/i.test(h)) {
          securitySchemes.bearerAuth = { type: "http", scheme: "bearer" };
          security.push({ bearerAuth: [] });
        } else if (/^cookie$/i.test(h)) {
          securitySchemes.cookieAuth = { type: "apiKey", in: "cookie", name: "session" };
          security.push({ cookieAuth: [] });
        } else {
          securitySchemes[name] = { type: "apiKey", in: "header", name: h };
          security.push({ [name]: [] });
        }
      }
      const responses = {};
      for (const code of Object.keys(e.statuses || {})) {
        responses[code] = { description: "Observed " + e.statuses[code] + " time(s)" };
        const schema = e.responseSchemas[code];
        if (schema) responses[code].content = { "application/json": { schema } };
      }
      if (!Object.keys(responses).length) responses.default = { description: "Not observed; found in source only" };

      const op = {
        operationId: camel(e.method.toLowerCase() + " " + e.path.replace(/[{}]/g, " ")),
        summary: (e.observed ? "Observed " : "Found in source only: ") + e.method + " " + e.path,
        responses
      };
      if (parameters.length) op.parameters = parameters;
      if (security.length) op.security = security;
      if (e.requestSchema) {
        op.requestBody = { content: { "application/json": { schema: e.requestSchema } } };
      }
      if (!e.observed) op["x-observed"] = false;
      if (e.foundIn) op["x-found-in"] = e.foundIn;
      item[e.method.toLowerCase()] = op;
    }
    const doc = {
      openapi: "3.0.3",
      info: {
        title: info.title || "Reverse-engineered API",
        version: "0.1.0",
        description:
          "Synthesized by chrome-controller-mcp from observed traffic" +
          (info.staticFindings ? " and static analysis of " + info.staticFindings + " source finding(s)" : "") +
          ". Endpoints marked x-observed: false were mined from JavaScript and never exercised."
      },
      paths
    };
    if (servers.length) doc.servers = servers;
    if (Object.keys(securitySchemes).length) doc.components = { securitySchemes };
    return doc;
  }

  // ---- Small helpers ---------------------------------------------------------

  // FNV-1a. Used to keep bundle filenames unique and short. Deliberately not
  // crypto: the service worker has it, but the offline test's vm sandbox does
  // not, and nothing here is security-relevant.
  function hash32(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
    }
    return ("0000000" + h.toString(16)).slice(-8);
  }

  function baseDomain(host) {
    const parts = String(host || "").split(".");
    return parts.length <= 2 ? String(host || "") : parts.slice(-2).join(".");
  }

  // Hostnames inside a blob of text (a bundle, a sitemap, a CSP header). Same
  // trade as mineSourceForEndpoints: a regex over minified source, tuned for
  // recall, with the caller deciding what is in scope.
  const HOST_IN_TEXT_RE =
    /(?:https?:)?\/\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)/gi;

  function isPlausibleHost(host) {
    if (!host || host.length > 253) return false;
    const labels = host.split(".");
    if (labels.length < 2) return false;
    const tld = labels[labels.length - 1];
    // A version string ("1.2.3"), a file ("app.min.js") and a selector
    // ("div.foo") all match a naive host regex. Requiring an alphabetic TLD of
    // a sane length drops nearly all of it.
    if (!/^[a-z]{2,24}$/i.test(tld)) return false;
    if (/^(js|css|json|map|html?|php|png|jpe?g|svg|gif|woff2?|ts|jsx|tsx|min|md|txt|xml|yml|yaml|sh|py|go|rs|vue|scss|less|exe|dll|dev|local)$/i.test(tld))
      return false;
    return labels.every((l) => l.length >= 1 && l.length <= 63);
  }

  function hostsFromText(text) {
    const out = [];
    const seen = Object.create(null);
    const src = String(text || "");
    HOST_IN_TEXT_RE.lastIndex = 0;
    let m;
    while ((m = HOST_IN_TEXT_RE.exec(src))) {
      const host = m[1].toLowerCase();
      if (seen[host] || !isPlausibleHost(host)) continue;
      seen[host] = 1;
      out.push(host);
    }
    return out;
  }

  // A Content-Security-Policy is a site telling you, in writing, every host its
  // own code is allowed to talk to. On a real app this is the single richest
  // source of backend hosts the UI never visits.
  function hostsFromCsp(csp) {
    const out = [];
    const seen = Object.create(null);
    for (const directive of String(csp || "").split(";")) {
      const tokens = directive.trim().split(/\s+/);
      for (let i = 1; i < tokens.length; i++) {
        let t = tokens[i].trim().toLowerCase();
        if (!t || t[0] === "'" || /^(data|blob|filesystem|mediastream|ws|wss|http|https):$/.test(t)) continue;
        t = t.replace(/^[a-z]+:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
        // *.example.com names the parent domain even though the wildcard host
        // itself is not resolvable; keep the parent, drop a bare "*".
        const wildcard = t.indexOf("*.") === 0;
        if (wildcard) t = t.slice(2);
        if (!t || t === "*" || seen[t] || !isPlausibleHost(t)) continue;
        seen[t] = 1;
        out.push(wildcard ? t : t);
      }
    }
    return out;
  }

  function inDomain(host, domain) {
    if (!host || !domain) return false;
    const h = host.toLowerCase();
    const d = domain.toLowerCase();
    return h === d || h.endsWith("." + d);
  }

  // Turn a fetched OpenAPI/Swagger document into findings, so an endpoint the
  // app declares but never calls lands in the catalog next to the observed
  // ones. This is the whole point of chasing well-known spec paths: it finds
  // the API surface no amount of clicking would reach.
  function openApiToFindings(doc, fileName, docUrl) {
    const out = [];
    if (!doc || typeof doc !== "object" || !doc.paths) return out;
    let base = "";
    let origin = null;
    try {
      origin = new URL(docUrl).origin;
    } catch (e) {}
    const servers = Array.isArray(doc.servers) ? doc.servers : null;
    if (servers && servers.length && servers[0] && typeof servers[0].url === "string") {
      const u = servers[0].url;
      if (/^https?:\/\//.test(u)) {
        try {
          const parsed = new URL(u);
          origin = parsed.origin;
          base = parsed.pathname.replace(/\/$/, "");
        } catch (e) {}
      } else base = u.replace(/\/$/, "");
    } else if (typeof doc.basePath === "string") {
      // Swagger 2.0
      base = doc.basePath.replace(/\/$/, "");
      if (Array.isArray(doc.schemes) && doc.schemes.length && typeof doc.host === "string") {
        origin = doc.schemes[0] + "://" + doc.host;
      } else if (typeof doc.host === "string") origin = "https://" + doc.host;
    }
    const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];
    for (const rawPath of Object.keys(doc.paths)) {
      const item = doc.paths[rawPath];
      if (!item || typeof item !== "object") continue;
      for (const m of METHODS) {
        if (!item[m]) continue;
        const op = item[m] || {};
        const full = (origin || "") + base + rawPath;
        out.push({
          kind: "openapi-doc",
          value: origin ? full : base + rawPath,
          method: m.toUpperCase(),
          file: fileName,
          index: 0,
          context:
            "declared in " + fileName + (op.summary ? ": " + String(op.summary).slice(0, 120) : ""),
          declared: true,
          operationId: op.operationId || null
        });
      }
    }
    return out;
  }

  function isFirstParty(url, origins) {
    let host;
    try {
      host = new URL(url).hostname;
    } catch (e) {
      return false;
    }
    const base = baseDomain(host);
    for (const o of origins || []) {
      try {
        if (baseDomain(new URL(o).hostname) === base) return true;
      } catch (e) {}
    }
    return false;
  }

  function scriptFileName(url) {
    let base = "script.js";
    try {
      const u = new URL(url);
      base = (u.pathname.split("/").pop() || "script") || "script";
    } catch (e) {}
    if (!/\.\w{1,6}$/.test(base)) base += ".js";
    return hash32(url) + "-" + base;
  }

  const AUTH_HEADER_RE = /^(authorization|cookie|x-csrf-token|x-xsrf-token|x-api-key|x-auth-token|x-access-token|x-session-token|api-key|apikey|x-amz-security-token|proxy-authorization)$/i;

  function pickAuthHeaders(headers) {
    const out = {};
    for (const k of Object.keys(headers || {})) {
      if (AUTH_HEADER_RE.test(k)) out[k.toLowerCase()] = headers[k];
    }
    return out;
  }

  function parseJsonMaybe(text, mime) {
    if (!text) return null;
    if (mime && !/json|javascript|text\/plain/i.test(mime)) return null;
    const t = text.trim();
    if (!t || (t[0] !== "{" && t[0] !== "[")) return null;
    try {
      return JSON.parse(t);
    } catch (e) {
      return null;
    }
  }

  // ===========================================================================
  // STATEFUL HALF — capture sessions, CDP, the crawl loop.
  // ===========================================================================

  const SESSIONS_KEY = "api_sessions_v1";
  const MAX_INDEX = 5000;          // request index entries held per session
  const MAX_SOURCE_BYTES = 24e6;   // total JS text held in memory for scanning
  const DEFAULT_BODY_LIMIT = 512 * 1024;
  const DEFAULT_RESOURCE_TYPES = ["XHR", "Fetch", "Document", "WebSocket", "EventSource"];

  // slug -> session. Also mirrored (index only, never bodies or sources) to
  // chrome.storage.session, same pattern as recorder_state_v1, so an eviction
  // mid-crawl does not throw away what we already know.
  const sessions = new Map();

  // One active session per tab. If two ever hold the same tab, every debugger
  // event goes to whichever this loop reaches first and the other silently
  // records nothing — which reads exactly like "the site fired no requests".
  // captureStart refuses to create that situation; this is just the reader.
  function sessionForTab(tabId) {
    for (const s of sessions.values()) {
      if (s.active && s.tabId === tabId) return s;
    }
    return null;
  }

  function persist() {
    try {
      const out = {};
      for (const s of sessions.values()) {
        out[s.slug] = {
          slug: s.slug,
          tabId: s.tabId,
          active: s.active,
          startedAt: s.startedAt,
          stoppedAt: s.stoppedAt,
          seq: s.seq,
          origins: s.origins,
          resourceTypes: s.resourceTypes,
          bodyLimit: s.bodyLimit,
          urlPattern: s.urlPattern,
          index: s.index,
          crawl: s.crawl ? Object.assign({}, s.crawl, { queue: (s.crawl.queue || []).slice(0, 200) }) : null,
          bundleDir: s.bundleDir
        };
      }
      chrome.storage.session.set({ [SESSIONS_KEY]: out }).catch(() => {});
    } catch (e) {}
  }

  async function hydrate() {
    try {
      const got = await chrome.storage.session.get(SESSIONS_KEY);
      const saved = got && got[SESSIONS_KEY];
      if (!saved) return;
      for (const slug of Object.keys(saved)) {
        if (sessions.has(slug)) continue;
        const s = saved[slug];
        sessions.set(slug, {
          slug: s.slug,
          tabId: s.tabId,
          active: s.active,
          startedAt: s.startedAt,
          stoppedAt: s.stoppedAt,
          seq: s.seq || 0,
          origins: s.origins || [],
          resourceTypes: s.resourceTypes || DEFAULT_RESOURCE_TYPES,
          bodyLimit: s.bodyLimit || DEFAULT_BODY_LIMIT,
          urlPattern: s.urlPattern || null,
          index: s.index || [],
          crawl: s.crawl || null,
          bundleDir: s.bundleDir || null,
          // Not persisted, rebuilt empty: in-flight records and fetched source
          // text. Losing them costs one re-run of api_fetch_source.
          inflight: new Map(),
          sources: [],
          sourceBytes: 0,
          findings: s.findings || [],
          pending: [],
          flushTimer: null,
          resumed: true
        });
      }
    } catch (e) {}
  }
  const hydrated = hydrate();

  async function getSession(slug, { create, tabId, opts } = {}) {
    await hydrated;
    let s = sessions.get(slug);
    if (!s && create) {
      s = {
        slug,
        tabId,
        active: false,
        startedAt: null,
        stoppedAt: null,
        seq: 0,
        origins: [],
        resourceTypes: DEFAULT_RESOURCE_TYPES,
        bodyLimit: DEFAULT_BODY_LIMIT,
        urlPattern: null,
        index: [],
        crawl: null,
        bundleDir: null,
        inflight: new Map(),
        sources: [],
        sourceBytes: 0,
        primaryOrigin: null,
        scriptUrls: [],
        crawlHistory: [],
        cspSeen: [],
        hosts: null,
        findings: [],
        pending: [],
        flushTimer: null
      };
      sessions.set(slug, s);
    }
    if (s && opts) Object.assign(s, opts);
    return s;
  }

  // ---- Disk writes -----------------------------------------------------------

  // Queue a file and flush the batch shortly after. A crawl generates bursts of
  // requests; one native message per file would be a message per request, and
  // the extension->host direction has no small size cap, so batching is free.
  function queueWrite(s, path, payload) {
    s.pending.push(Object.assign({ path }, payload));
    if (s.flushTimer) return;
    s.flushTimer = setTimeout(() => {
      s.flushTimer = null;
      flush(s).catch(() => {});
    }, 300);
  }

  async function flush(s) {
    if (s.flushTimer) {
      clearTimeout(s.flushTimer);
      s.flushTimer = null;
    }
    if (!s.pending.length) return null;
    const files = s.pending;
    s.pending = [];
    const res = await deps.apiWrite(s.slug, files);
    if (res && res.dir) s.bundleDir = res.dir;
    persist();
    return res;
  }

  // ---- CDP event handling ----------------------------------------------------

  function wantType(s, type) {
    if (!type) return false;
    return s.resourceTypes.indexOf(type) !== -1;
  }

  function skippableUrl(url) {
    return !url || /^(data|blob|chrome-extension|about|javascript):/i.test(url);
  }

  function noteOrigin(s, url) {
    // A sandboxed iframe or data: document reports its origin as the string
    // "null". Recorded, it becomes origins[0] and every real host then fails the
    // first-party test — which is how a page serving 17 of its own bundles got
    // told it "serves no first-party scripts".
    if (!/^https?:\/\//i.test(String(url || ""))) return;
    try {
      const o = new URL(url).origin;
      if (s.origins.indexOf(o) === -1) s.origins.push(o);
    } catch (e) {}
  }

  // Network.enable is per-DevTools-session state. Any detach — the user
  // dismissing the debugger bar, a renderer crash, an eviction of the service
  // worker that owns the attachment bookkeeping — clears it, and background.js
  // rebuilds enabledDomains empty on reattach. The crawl only ever asks for
  // Runtime and Page, so those come back while Network stays off: CDP commands
  // keep succeeding, screenshots keep landing, and every request silently stops
  // being recorded. Re-arming is idempotent and cheap, so do it whenever the
  // capture is about to depend on the event stream.
  async function armNetwork(tabId) {
    await deps.ensureAttached(tabId);
    await deps.ensureDomain(tabId, "Network");
    await deps.cdp(tabId, "Network.enable", {
      maxTotalBufferSize: 100000000,
      maxResourceBufferSize: 20000000
    });
    try {
      await deps.cdp(tabId, "Network.setCacheDisabled", { cacheDisabled: true });
    } catch (e) {}
  }

  // A detach kills the event stream for every capture holding that tab. Re-arm
  // instead of waiting for the next tool call to notice the silence.
  function onDebuggerDetach(tabId) {
    const s = sessionForTab(tabId);
    if (!s) return;
    s.detaches = (s.detaches || 0) + 1;
    armNetwork(tabId).catch(() => {});
  }

  function onDebuggerEvent(tabId, method, params) {
    const s = sessionForTab(tabId);
    if (!s || !s.active || !params) return;
    try {
      switch (method) {
        case "Network.requestWillBeSent": {
          // A redirect reuses the requestId: close out the hop we already have
          // before overwriting it, or the redirect chain vanishes.
          if (params.redirectResponse && s.inflight.has(params.requestId)) {
            const prev = s.inflight.get(params.requestId);
            applyResponse(prev, params.redirectResponse);
            prev.redirect = true;
            finishRecord(s, params.requestId, prev, { skipBody: true });
          }
          if (skippableUrl(params.request.url)) return;
          const rec = {
            requestId: params.requestId,
            type: params.type || "Other",
            method: params.request.method,
            url: params.request.url,
            requestHeaders: Object.assign({}, params.request.headers),
            requestBody: params.request.postData || null,
            hasPostData: !!params.request.hasPostData,
            initiator: params.initiator || null,
            documentURL: params.documentURL || null,
            frameId: params.frameId || null,
            wallTime: params.wallTime ? Math.round(params.wallTime * 1000) : Date.now(),
            page: (s.crawl && s.crawl.currentUrl) || null
          };
          s.inflight.set(params.requestId, rec);
          noteOrigin(s, rec.url);
          break;
        }
        case "Network.requestWillBeSentExtraInfo": {
          // The headers the browser is actually sending, Cookie included. The
          // page-supplied set above is a subset and misses exactly the parts
          // needed to replay the call.
          const rec = s.inflight.get(params.requestId);
          if (rec) rec.requestHeaders = Object.assign({}, rec.requestHeaders, params.headers || {});
          break;
        }
        case "Network.responseReceived": {
          const rec = s.inflight.get(params.requestId);
          if (!rec) return;
          rec.type = params.type || rec.type;
          applyResponse(rec, params.response);
          break;
        }
        case "Network.responseReceivedExtraInfo": {
          const rec = s.inflight.get(params.requestId);
          if (rec) rec.rawResponseHeaders = params.headers || null;
          break;
        }
        case "Network.loadingFinished": {
          const rec = s.inflight.get(params.requestId);
          if (!rec) return;
          rec.encodedDataLength = params.encodedDataLength;
          finishRecord(s, params.requestId, rec, {});
          break;
        }
        case "Network.loadingFailed": {
          const rec = s.inflight.get(params.requestId);
          if (!rec) return;
          rec.failed = params.errorText || "failed";
          rec.canceled = !!params.canceled;
          finishRecord(s, params.requestId, rec, { skipBody: true });
          break;
        }
        case "Network.webSocketCreated": {
          const rec = {
            requestId: params.requestId,
            type: "WebSocket",
            method: "WS",
            url: params.url,
            requestHeaders: {},
            frames: [],
            wallTime: Date.now(),
            page: (s.crawl && s.crawl.currentUrl) || null
          };
          s.inflight.set(params.requestId, rec);
          noteOrigin(s, params.url);
          break;
        }
        case "Network.webSocketFrameSent":
        case "Network.webSocketFrameReceived": {
          const rec = s.inflight.get(params.requestId);
          if (!rec || !rec.frames) return;
          if (rec.frames.length >= 200) return;
          rec.frames.push({
            dir: method === "Network.webSocketFrameSent" ? "out" : "in",
            at: Date.now(),
            payload: String((params.response && params.response.payloadData) || "").slice(0, 8192)
          });
          break;
        }
        case "Network.webSocketClosed": {
          const rec = s.inflight.get(params.requestId);
          if (rec) finishRecord(s, params.requestId, rec, { skipBody: true });
          break;
        }
      }
    } catch (e) {
      // A capture bug must never break the tab's debugger listener.
    }
  }

  function applyResponse(rec, response) {
    rec.status = response.status;
    rec.statusText = response.statusText;
    rec.mime = response.mimeType;
    rec.responseHeaders = Object.assign({}, response.headers);
    rec.remoteAddress = response.remoteIPAddress ? response.remoteIPAddress + ":" + response.remotePort : null;
    rec.protocol = response.protocol || null;
    rec.fromCache = !!response.fromDiskCache || !!response.fromPrefetchCache;
    rec.timing = response.timing || null;
    rec.securityState = response.securityState || null;
  }

  // Pull the body (while CDP still has it) and write the record out. Called
  // from a sync event handler, so it must not be awaited there.
  function finishRecord(s, requestId, rec, { skipBody }) {
    s.inflight.delete(requestId);
    // Script bodies are not API traffic and are deliberately not recorded, but
    // the URLs are the only way api_fetch_source can find the bundles later.
    // Without this it can only ask the page, which fails the moment the tab is
    // gone — and a closed tab is exactly when you still want the static half.
    // First-party means "the site being mapped", which is the document's origin —
    // NOT any origin seen in traffic. s.origins accumulates every host the page
    // talks to, analytics and ad tags included, so testing against that list
    // made the first-party filter match everything and do nothing.
    if (!s.primaryOrigin && rec.type === "Document" && /^https?:/i.test(rec.url || "")) {
      try {
        s.primaryOrigin = new URL(rec.url).origin;
      } catch (e) {}
    }
    if (rec.type === "Script" && rec.url && /^https?:/i.test(rec.url)) {
      const list = s.scriptUrls || (s.scriptUrls = []);
      if (list.indexOf(rec.url) === -1 && list.length < 600) list.push(rec.url);
    }
    const keep = wantType(s, rec.type);
    if (!keep) return;
    if (s.urlPattern && rec.url.indexOf(s.urlPattern) === -1) return;

    const done = () => {
      const seq = ++s.seq;
      const file = "requests/" + String(seq).padStart(5, "0") + ".json";
      rec.seq = seq;
      queueWrite(s, file, { json: rec });
      indexRecord(s, rec, file);
    };

    if (skipBody || rec.frames) {
      done();
      return;
    }
    deps
      .cdp(s.tabId, "Network.getResponseBody", { requestId })
      .then((r) => {
        if (!r) return;
        const limit = s.bodyLimit;
        if (r.base64Encoded) {
          rec.responseBodyBase64 = String(r.body || "").slice(0, Math.ceil(limit * 1.34));
          rec.responseBodyTruncated = (r.body || "").length > Math.ceil(limit * 1.34);
        } else {
          const body = String(r.body || "");
          rec.responseBody = body.slice(0, limit);
          rec.responseBodyTruncated = body.length > limit;
        }
      })
      .catch((e) => {
        // Normal, not exceptional: 204s, redirects and anything served from
        // cache have no body for CDP to hand back.
        rec.responseBodyError = String((e && e.message) || e);
      })
      .then(done, done);
  }

  // The compact, in-memory view that api_spec later works from. Schemas are
  // inferred here, once, while the bodies are in hand — nothing re-reads the
  // files we just wrote.
  function indexRecord(s, rec, file) {
    let query = null;
    try {
      query = new URL(rec.url).search || null;
    } catch (e) {}
    const entry = {
      seq: rec.seq,
      file,
      method: rec.method,
      url: rec.url,
      status: rec.status || 0,
      mime: rec.mime || null,
      type: rec.type,
      query,
      page: rec.page || null,
      failed: rec.failed || null,
      authHeaders: pickAuthHeaders(rec.requestHeaders),
      reqHeaderNames: Object.keys(rec.requestHeaders || {}),
      bytes: rec.encodedDataLength || 0
    };
    const reqJson = parseJsonMaybe(rec.requestBody, (rec.requestHeaders || {})["content-type"] || "application/json");
    if (reqJson) entry.reqSchema = inferJsonSchema(reqJson);
    const respJson = parseJsonMaybe(rec.responseBody, rec.mime);
    if (respJson) entry.respSchema = inferJsonSchema(respJson);
    if (rec.frames && rec.frames.length) {
      entry.frameCount = rec.frames.length;
      const sample = parseJsonMaybe(rec.frames[0].payload, "application/json");
      if (sample) entry.respSchema = inferJsonSchema(sample);
    }
    const rh = rec.responseHeaders || {};
    const csp = rh["content-security-policy"] || rh["content-security-policy-report-only"];
    if (csp) {
      const seen = s.cspSeen || (s.cspSeen = []);
      if (seen.indexOf(csp) === -1 && seen.length < 20) seen.push(csp);
    }
    s.index.push(entry);
    if (s.index.length > MAX_INDEX) s.index.splice(0, s.index.length - MAX_INDEX);
  }

  // ---- api_capture -----------------------------------------------------------

  async function captureStart(args) {
    // Before anything is created or attached: one active session per tab. Two
    // captures on one tab is always a mistake, and a silent one — every network
    // event goes to whichever session claimed the tab first, so the second
    // attaches, reports success, and records nothing at all.
    await getSession(args.slug, {});
    const holder = sessionForTab(args.tabId);
    if (holder && holder.slug !== args.slug) {
      return (
        "Tab " + args.tabId + " is already being captured by session '" + holder.slug + "'. Every network event " +
        "from that tab goes to the session that claimed it first, so a second capture here would record nothing. " +
        "Stop that one first (api_capture action:'stop' slug:'" + holder.slug + "'), or capture a different tab."
      );
    }

    const s = await getSession(args.slug, {
      create: true,
      tabId: args.tabId,
      opts: {
        tabId: args.tabId,
        active: true,
        startedAt: Date.now(),
        stoppedAt: null,
        resourceTypes: Array.isArray(args.resourceTypes) && args.resourceTypes.length ? args.resourceTypes : DEFAULT_RESOURCE_TYPES,
        bodyLimit: typeof args.bodyLimit === "number" ? args.bodyLimit : DEFAULT_BODY_LIMIT,
        urlPattern: args.urlPattern || null
      }
    });
    // Buffer sizes matter: the defaults are small enough that bodies get
    // evicted before we ask for them on a busy page. Cache disabled because a
    // cached response has no body to fetch, which silently produces records
    // with no payload — correctness beats speed while capturing.
    await armNetwork(args.tabId);


    const tab = await chrome.tabs.get(args.tabId);
    if (tab && tab.url) noteOrigin(s, tab.url);
    queueWrite(s, "session.json", { json: sessionSummary(s) });
    const res = await flush(s);
    return (
      "Capture started for slug '" + s.slug + "' on tab " + s.tabId + ".\n" +
      "Bundle: " + (s.bundleDir || (res && res.dir) || "(pending first write)") + "\n" +
      "Recording resource types: " + s.resourceTypes.join(", ") +
      (s.urlPattern ? "\nOnly URLs containing: " + s.urlPattern : "") +
      "\nBody limit: " + s.bodyLimit + " bytes. Response cache disabled for this tab so bodies are always available.\n" +
      "Now drive the app (or call api_crawl), then api_capture action:'read' or action:'stop'."
    );
  }

  function sessionSummary(s) {
    return {
      slug: s.slug,
      tabId: s.tabId,
      active: s.active,
      startedAt: s.startedAt ? new Date(s.startedAt).toISOString() : null,
      stoppedAt: s.stoppedAt ? new Date(s.stoppedAt).toISOString() : null,
      origins: s.origins,
      resourceTypes: s.resourceTypes,
      urlPattern: s.urlPattern,
      bodyLimit: s.bodyLimit,
      requestsCaptured: s.seq,
      indexed: s.index.length,
      staticFindings: s.findings.length,
      sourcesFetched: s.sources.length,
      crawl: s.crawl
        ? {
            running: s.crawl.running,
            visited: (s.crawl.visited || []).length,
            queued: (s.crawl.queue || []).length,
            pages: (s.crawl.pages || []).length,
            interact: !!s.crawl.interact,
            stoppedReason: s.crawl.stoppedReason || null
          }
        : null
    };
  }

  async function captureStop(args) {
    const s = await getSession(args.slug);
    if (!s) return "No capture session named '" + args.slug + "'.";
    s.active = false;
    s.stoppedAt = Date.now();
    if (s.crawl) {
      s.crawl.running = false;
      s.crawl.stoppedReason = s.crawl.stoppedReason || "capture stopped";
    }
    try {
      await deps.cdp(s.tabId, "Network.setCacheDisabled", { cacheDisabled: false });
    } catch (e) {}
    queueWrite(s, "session.json", { json: sessionSummary(s) });
    await flush(s);
    return (
      "Capture stopped for '" + s.slug + "'. " + s.seq + " request(s) written to " + (s.bundleDir || "the bundle") + "/requests/.\n" +
      "Next: api_capture action:'auth' (before the session expires), api_fetch_source, api_scan_source, then api_spec."
    );
  }

  async function captureStatus(args) {
    const s = await getSession(args.slug);
    if (!s) return "No capture session named '" + args.slug + "'.";
    await flush(s);
    return JSON.stringify(
      Object.assign(sessionSummary(s), {
        bundleDir: s.bundleDir,
        inflight: s.inflight.size,
        resumedAfterEviction: !!s.resumed
      }),
      null,
      2
    );
  }

  async function captureRead(args) {
    const s = await getSession(args.slug);
    if (!s) return "No capture session named '" + args.slug + "'.";
    await flush(s);
    let rows = s.index;
    if (args.urlPattern) rows = rows.filter((r) => r.url.indexOf(args.urlPattern) !== -1);
    const limit = typeof args.limit === "number" ? args.limit : 100;
    const shown = rows.slice(-limit);
    if (!shown.length) {
      return (
        "No requests captured yet for '" + s.slug + "'" + (args.urlPattern ? " matching " + args.urlPattern : "") + ".\n" +
        (s.active ? "Capture is running — drive the app or call api_crawl." : "Capture is stopped; start it before acting on the page.")
      );
    }
    const lines = shown.map((r) => {
      let p = r.url;
      try {
        const u = new URL(r.url);
        p = u.pathname + (u.search || "");
      } catch (e) {}
      return (
        "#" + r.seq + " " + r.method + " " + p +
        " -> " + (r.failed ? "FAILED " + r.failed : r.status) +
        (r.mime ? " [" + r.mime + "]" : "") +
        (r.reqSchema ? " req:json" : "") +
        (r.respSchema ? " resp:json" : "") +
        (Object.keys(r.authHeaders).length ? " auth:" + Object.keys(r.authHeaders).join("+") : "")
      );
    });
    return (
      "Captured requests for '" + s.slug + "' (" + shown.length + " of " + rows.length + " shown, full records in " +
      (s.bundleDir || "the bundle") + "/requests/):\n" + lines.join("\n")
    );
  }

  // Auth snapshot. This writes live credentials to disk on purpose — the point
  // is a generated client that actually works — so it is loud about what it
  // just persisted, and it scopes cookies to the origins this session saw
  // rather than dumping every cookie in the browser.
  async function captureAuth(args) {
    const s = await getSession(args.slug, { create: true, tabId: args.tabId });
    if (args.tabId) s.tabId = args.tabId;
    await deps.ensureAttached(s.tabId);
    await deps.ensureDomain(s.tabId, "Network");

    const hosts = s.origins
      .map((o) => {
        try {
          return new URL(o).hostname;
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean);
    try {
      const tab = await chrome.tabs.get(s.tabId);
      if (tab && tab.url) {
        const h = new URL(tab.url).hostname;
        if (hosts.indexOf(h) === -1) hosts.push(h);
      }
    } catch (e) {}

    let cookies = [];
    try {
      const r = await deps.cdp(s.tabId, "Network.getAllCookies", {});
      cookies = (r && r.cookies) || [];
    } catch (e) {}
    const scoped = args.allCookies
      ? cookies
      : cookies.filter((c) => {
          const d = String(c.domain || "").replace(/^\./, "");
          return hosts.some((h) => h === d || h.endsWith("." + d) || d.endsWith("." + h));
        });

    let storage = { localStorage: {}, sessionStorage: {}, error: null };
    try {
      const r = await deps.cdp(s.tabId, "Runtime.evaluate", {
        expression:
          "(()=>{const d=(s)=>{const o={};try{for(let i=0;i<s.length;i++){const k=s.key(i);o[k]=String(s.getItem(k)).slice(0,4096);}}catch(e){o.__error=String(e&&e.message);}return o;};" +
          "return JSON.stringify({localStorage:d(localStorage),sessionStorage:d(sessionStorage),href:location.href});})()",
        returnByValue: true,
        awaitPromise: true
      });
      const parsed = r && r.result && r.result.value ? JSON.parse(r.result.value) : null;
      if (parsed) storage = parsed;
    } catch (e) {
      storage.error = String((e && e.message) || e);
    }

    // Which auth headers the app actually sends, and to what. This is the part
    // that tells the generated client what to set.
    const headerUse = {};
    for (const r of s.index) {
      for (const k of Object.keys(r.authHeaders || {})) {
        const u = (headerUse[k] = headerUse[k] || { name: k, value: r.authHeaders[k], endpoints: [] });
        let p = r.url;
        try {
          p = new URL(r.url).pathname;
        } catch (e) {}
        const t = templatePath(p).template;
        if (u.endpoints.indexOf(t) === -1 && u.endpoints.length < 25) u.endpoints.push(t);
      }
    }

    const auth = {
      slug: s.slug,
      capturedAt: new Date().toISOString(),
      warning: "LIVE CREDENTIALS. Cookies, tokens and headers below are real and usable. Do not commit or share this file.",
      hosts,
      cookies: scoped,
      cookieScope: args.allCookies ? "every cookie in the browser" : "cookies matching the captured origins",
      localStorage: storage.localStorage || {},
      sessionStorage: storage.sessionStorage || {},
      authHeaders: headerUse,
      pageUrl: storage.href || null
    };
    queueWrite(s, "auth.json", { json: auth });
    await flush(s);

    const secretCount =
      scoped.length + Object.keys(auth.localStorage).length + Object.keys(auth.sessionStorage).length + Object.keys(headerUse).length;
    return (
      "Wrote auth.json to " + (s.bundleDir || "the bundle") + " with LIVE credentials: " +
      scoped.length + " cookie(s) (" + auth.cookieScope + "), " +
      Object.keys(auth.localStorage).length + " localStorage key(s), " +
      Object.keys(auth.sessionStorage).length + " sessionStorage key(s), " +
      Object.keys(headerUse).length + " auth header(s) seen in traffic" +
      (Object.keys(headerUse).length ? " (" + Object.keys(headerUse).join(", ") + ")" : "") + ".\n" +
      secretCount + " secret value(s) are now in plaintext on disk. Do not commit that folder."
    );
  }

  async function capture(args) {
    const action = args.action || "status";
    if (!args.slug) return "Error: slug is required — it names the folder under custom_apis/ that this site's bundle lives in.";
    switch (action) {
      case "start":
        if (!args.tabId) return "Error: tabId is required to start a capture. Use tabs_context_mcp to find it.";
        return captureStart(args);
      case "stop":
        return captureStop(args);
      case "status":
        return captureStatus(args);
      case "read":
        return captureRead(args);
      case "auth":
        return captureAuth(args);
      default:
        return "Error: unknown action '" + action + "'. Use start, stop, status, read or auth.";
    }
  }

  // ---- api_fetch_source ------------------------------------------------------

  // Fetched from the service worker rather than from the page: the worker has
  // <all_urls> host permission, so it is not subject to CORS or to the page's
  // connect-src, which is what blocks the obvious javascript_tool + fetch
  // approach on exactly the apps worth mapping.
  async function fetchText(url) {
    const res = await fetch(url, { credentials: "include", cache: "no-store" });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, contentType: res.headers.get("content-type") || null };
  }

  function addSource(s, name, url, text) {
    if (s.sourceBytes + text.length > MAX_SOURCE_BYTES) return false;
    s.sources.push({ name, url, length: text.length, text });
    s.sourceBytes += text.length;
    return true;
  }

  async function fetchSource(args) {
    if (!args.slug) return "Error: slug is required.";
    const s = await getSession(args.slug, { create: true, tabId: args.tabId });
    if (args.tabId) s.tabId = args.tabId;

    let urls = [];
    if (args.url) urls = [args.url];
    else if (args.all !== false) {
      // Every script the page pulled in. Document-type records are skipped:
      // the HTML is already in requests/ and mining it is api_scan_source's
      // job only if the caller asks for it explicitly by url.
      const seen = Object.create(null);
      for (const r of s.index) {
        if (r.type !== "Script") continue;
        if (seen[r.url]) continue;
        seen[r.url] = 1;
        urls.push(r.url);
      }
      // The URLs kept aside during capture, which is where they come from under
      // the default resourceTypes (Script bodies are not recorded).
      for (const u of s.scriptUrls || []) {
        if (seen[u]) continue;
        seen[u] = 1;
        urls.push(u);
      }
      // Nothing captured yet? Ask the page what it loaded.
      if (!urls.length && s.tabId) {
        try {
          const r = await deps.cdp(s.tabId, "Runtime.evaluate", {
            expression:
              "JSON.stringify(Array.from(document.querySelectorAll('script[src]')).map(x=>x.src)" +
              ".concat(performance.getEntriesByType('resource').filter(e=>e.initiatorType==='script').map(e=>e.name)))",
            returnByValue: true
          });
          urls = JSON.parse((r && r.result && r.result.value) || "[]");
        } catch (e) {}
      }
    }
    // Dedupe unconditionally. Dropping this into only the capture branch is how
    // an earlier version fetched and wrote every bundle twice.
    const uniq = Object.create(null);
    urls = urls.filter((u) => {
      if (!/^https?:/i.test(u) || uniq[u]) return false;
      uniq[u] = 1;
      return true;
    });

    // Third-party scripts are the app's analytics and ad tags, not its API.
    // Left in, Google Tag Manager alone contributes hundreds of tracking
    // endpoints and buries the handful that belong to the app being mapped.
    if (!args.includeThirdParty && s.origins.length && !args.url) {
      const before = urls.length;
      const scope = s.primaryOrigin ? [s.primaryOrigin] : s.origins.slice(0, 1);
      const firstParty = urls.filter((u) => isFirstParty(u, scope));
      // Unless that leaves nothing — a site serving its whole bundle from a CDN
      // is normal, and returning zero scripts would be useless.
      if (firstParty.length) {
        s.skippedThirdParty = before - firstParty.length;
        s.thirdPartyFallback = false;
        urls = firstParty;
      } else {
        s.skippedThirdParty = 0;
        s.thirdPartyFallback = true;
      }
    }

    if (!urls.length) {
      return (
        "No script URLs to fetch for '" + s.slug + "'. Either start a capture and load the app first " +
        "(api_capture action:'start' with resourceTypes including 'Script'), or pass an explicit url."
      );
    }
    const max = typeof args.limit === "number" ? args.limit : 40;
    urls = urls.slice(0, max);

    const wantMaps = args.sourcemaps !== false;
    const manifest = [];
    for (const url of urls) {
      let got;
      try {
        got = await fetchText(url);
      } catch (e) {
        manifest.push({ url, error: String((e && e.message) || e) });
        continue;
      }
      const name = scriptFileName(url);
      queueWrite(s, "static/scripts/" + name, { text: got.text });
      const held = addSource(s, name, url, got.text);
      const entry = { url, file: "static/scripts/" + name, bytes: got.text.length, status: got.status, heldForScanning: held };

      if (wantMaps) {
        const m = /\/[/*]#\s*sourceMappingURL=([^\s*]+)/.exec(got.text.slice(-4096)) || /\/[/*]#\s*sourceMappingURL=([^\s*]+)/.exec(got.text);
        if (m && !/^data:/i.test(m[1])) {
          try {
            const mapUrl = new URL(m[1], url).href;
            const map = await fetchText(mapUrl);
            queueWrite(s, "static/scripts/" + name + ".map", { text: map.text });
            entry.sourcemap = "static/scripts/" + name + ".map";
            // sourcesContent is the prize: original, unminified sources with
            // real filenames, which makes the static scan both accurate and
            // attributable instead of pointing at column 84102 of a bundle.
            const parsed = JSON.parse(map.text);
            const srcs = parsed.sources || [];
            const contents = parsed.sourcesContent || [];
            let wrote = 0;
            for (let i = 0; i < srcs.length && i < 400; i++) {
              const body = contents[i];
              if (typeof body !== "string" || !body) continue;
              const rel = "static/sources/" + String(srcs[i]).replace(/^(\.\.\/|\/|webpack:\/\/)+/g, "").replace(/[^A-Za-z0-9._/-]/g, "-");
              queueWrite(s, rel, { text: body });
              addSource(s, rel, url + " <- " + srcs[i], body);
              wrote++;
            }
            entry.originalSources = wrote;
          } catch (e) {
            entry.sourcemapError = String((e && e.message) || e);
          }
        }
      }
      manifest.push(entry);
      await flush(s);
    }
    queueWrite(s, "static/manifest.json", { json: { fetchedAt: new Date().toISOString(), scripts: manifest } });
    await flush(s);

    const okCount = manifest.filter((e) => !e.error).length;
    const maps = manifest.filter((e) => e.sourcemap).length;
    const origs = manifest.reduce((n, e) => n + (e.originalSources || 0), 0);
    return (
      "Fetched " + okCount + "/" + manifest.length + " script(s) into " + (s.bundleDir || "the bundle") + "/static/scripts/" +
      (maps ? ", " + maps + " sourcemap(s)" : "") + (origs ? ", " + origs + " original source file(s) into static/sources/" : "") + ".\n" +
      (s.skippedThirdParty
        ? "Skipped " + s.skippedThirdParty + " third-party script(s) (analytics, ads, CDN tags) — pass includeThirdParty: true to mine those too.\n"
        : "") +
      (s.thirdPartyFallback
        ? "Note: this app serves no first-party scripts, so these are all third-party (analytics, ads, CDN). Expect the findings to be mostly tracking endpoints rather than the app's API.\n"
        : "") +
      "Holding " + s.sources.length + " file(s) / " + Math.round(s.sourceBytes / 1024) + "KB in memory for api_scan_source.\n" +
      manifest
        .slice(0, 25)
        .map((e) => "  " + (e.error ? "ERROR " + e.error + " " : "") + e.url + (e.bytes ? " (" + Math.round(e.bytes / 1024) + "KB)" : ""))
        .join("\n") +
      (manifest.length > 25 ? "\n  … " + (manifest.length - 25) + " more (see static/manifest.json)" : "")
    );
  }

  // ---- api_scan_source -------------------------------------------------------

  async function scanSource(args) {
    if (!args.slug) return "Error: slug is required.";
    const s = await getSession(args.slug);
    if (!s) return "No session named '" + args.slug + "'. Run api_capture action:'start' first.";
    if (!s.sources.length) {
      return (
        "No source held in memory for '" + s.slug + "'. Run api_fetch_source first — the scan works from what that tool " +
        "is still holding, since the extension can write files but cannot read them back" +
        (s.resumed ? " (and this session was restored after a service-worker eviction, which drops held sources)" : "") + "."
      );
    }
    let findings = [];
    for (const src of s.sources) {
      const got = mineSourceForEndpoints(src.text, src.name);
      findings = findings.concat(got);
    }
    // Same value found in two bundles is one finding with two homes.
    const byValue = Object.create(null);
    const merged = [];
    for (const f of findings) {
      const key = f.kind + " " + (f.method || "") + " " + f.value;
      if (byValue[key]) {
        const e = byValue[key];
        e.count += f.count || 1;
        if (e.files.indexOf(f.file) === -1 && e.files.length < 10) e.files.push(f.file);
        continue;
      }
      const e = Object.assign({}, f, { files: [f.file] });
      byValue[key] = e;
      merged.push(e);
    }
    merged.sort((a, b) => b.score - a.score || b.count - a.count || a.value.localeCompare(b.value));
    s.findings = merged;

    queueWrite(s, "static/findings.json", {
      json: { scannedAt: new Date().toISOString(), filesScanned: s.sources.length, findings: merged }
    });
    await flush(s);

    const byKind = {};
    for (const f of merged) byKind[f.kind] = (byKind[f.kind] || 0) + 1;
    const top = merged.slice(0, 40).map((f) => "  [" + f.score + "] " + f.kind + " " + (f.method ? f.method + " " : "") + f.value);
    const specDocs = merged.filter((f) => f.kind === "spec-document");
    return (
      "Scanned " + s.sources.length + " file(s), " + merged.length + " candidate endpoint(s) -> " +
      (s.bundleDir || "the bundle") + "/static/findings.json\n" +
      "By kind: " + Object.keys(byKind).map((k) => k + "=" + byKind[k]).join(", ") + "\n" +
      (specDocs.length
        ? "A machine-readable spec is referenced in the bundle — fetch it directly, it beats everything else here: " +
          specDocs.map((f) => f.value).join(", ") + "\n"
        : "") +
      "Top candidates:\n" + top.join("\n") +
      (merged.length > 40 ? "\n  … " + (merged.length - 40) + " more in findings.json" : "")
    );
  }

  // ---- api_crawl -------------------------------------------------------------

  // Anything whose URL or label suggests it changes state. The crawler will not
  // follow or click these even with force: true — force buys you interaction
  // with ordinary controls, not a licence to press "Delete".
  const DENY_RE = /(log[\s_-]?out|sign[\s_-]?out|sign[\s_-]?off|delete|destroy|remove|revoke|cancel|refund|charge|check[\s_-]?out|purchase|pay(ment)?\b|transfer|withdraw|deactivate|disable|unsubscribe|reset[\s_-]?password|confirm|approve|submit|send)/i;

  function sameOrigin(a, b) {
    try {
      return new URL(a).origin === new URL(b).origin;
    } catch (e) {
      return false;
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitForLoad(tabId, timeoutMs) {
    const until = Date.now() + (timeoutMs || 15000);
    while (Date.now() < until) {
      try {
        const t = await chrome.tabs.get(tabId);
        if (t && t.status === "complete") return true;
      } catch (e) {
        return false;
      }
      await sleep(200);
    }
    return false;
  }

  // Idle means "no new request started for `quiet` ms". Watching our own capture
  // index is enough and avoids a second bookkeeping path.
  async function waitForNetworkIdle(s, quiet, maxMs) {
    const q = quiet || 800;
    const deadline = Date.now() + (maxMs || 8000);
    let last = s.seq;
    let lastChange = Date.now();
    while (Date.now() < deadline) {
      await sleep(200);
      if (s.seq !== last) {
        last = s.seq;
        lastChange = Date.now();
      } else if (Date.now() - lastChange >= q) {
        return true;
      }
    }
    return false;
  }

  async function evalJson(tabId, expression) {
    const r = await deps.cdp(tabId, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) return null;
    const v = r && r.result ? r.result.value : null;
    if (typeof v === "string") {
      try {
        return JSON.parse(v);
      } catch (e) {
        return null;
      }
    }
    return v;
  }

  // Links plus whatever the framework will admit about its own routes. The
  // route table matters more than the links on many SPAs, where the nav is
  // rendered lazily and half the app is unreachable from the current page.
  // Deliberately excludes input[type=submit] and form submission: a submit is
  // the click most likely to write something, and unlike the deny list this is
  // not a matter of guessing from a label.
  const CONTROL_SEL =
    "button:not([type=submit]),[role=button],[role=tab],[role=menuitem],summary,input[type=button],[onclick]";

  // Click by re-querying in the page rather than by coordinate. Coordinates
  // from getBoundingClientRect are viewport-relative, so anything below the
  // fold got clicked at a y outside the viewport and hit nothing at all — the
  // first version of this dutifully reported "clicked: Run script, 0 new
  // requests" for a button that fires a fetch. Re-querying also survives the
  // re-render a click usually causes, which invalidates every coordinate held
  // from before it.
  const clickExpr = (index) =>
    "JSON.stringify((()=>{" +
    "const sel=" + JSON.stringify(CONTROL_SEL) + ";" +
    "const all=[];" +
    "for(const el of document.querySelectorAll(sel)){" +
    "const t=(el.innerText||el.getAttribute('aria-label')||el.getAttribute('title')||el.value||'').trim().slice(0,60);" +
    "if(!t)continue;const r=el.getBoundingClientRect();if(!r.width||!r.height)continue;all.push({el:el,t:t});}" +
    "const hit=all[" + Number(index) + "];" +
    "if(!hit)return{ok:false,why:'control no longer present'};" +
    "try{hit.el.scrollIntoView({block:'center'});}catch(e){}" +
    // A click must not be able to close the tab out from under the crawler.
    // Chrome allows window.close() from a page in a tab an extension opened,
    // and a crawl of a trading platform lost its tab mid-run this way: every
    // remaining page then failed with 'No tab with given id'.
    "var closed=false;try{window.close=function(){closed=true;};}catch(e){}" +
    "const before=location.href;" +
    "try{hit.el.click();}catch(e){return{ok:false,text:hit.t,why:String(e&&e.message||e)};}" +
    "return{ok:true,text:hit.t,href:before,controls:all.length,triedToClose:closed};})())";

  const COLLECT_EXPR =
    "JSON.stringify((()=>{" +
    "const out={href:location.href,title:document.title,links:[],routes:[],controls:[]};" +
    "const seen={};" +
    "for(const a of document.querySelectorAll('a[href]')){const h=a.href;if(!h||seen[h])continue;seen[h]=1;" +
    "if(/^javascript:|^mailto:|^tel:|#$/.test(a.getAttribute('href')||''))continue;out.links.push({href:h,text:(a.innerText||'').trim().slice(0,80)});if(out.links.length>300)break;}" +
    "try{const n=window.__NEXT_DATA__;if(n){if(n.page)out.routes.push(n.page);const bp=n.buildManifest&&n.buildManifest.sortedPages;if(bp)out.routes=out.routes.concat(bp);}}catch(e){}" +
    "try{const r=window.__remixManifest;if(r&&r.routes)out.routes=out.routes.concat(Object.values(r.routes).map(x=>x.path).filter(Boolean));}catch(e){}" +
    "try{const rt=window.__NUXT__&&window.__NUXT__.routePath;if(rt)out.routes.push(rt);}catch(e){}" +
    "try{const app=document.querySelector('#app,#root');const vr=app&&app.__vue_app__&&app.__vue_app__.config&&app.__vue_app__.config.globalProperties&&app.__vue_app__.config.globalProperties.$router;" +
    "if(vr&&vr.getRoutes)out.routes=out.routes.concat(vr.getRoutes().map(x=>x.path));}catch(e){}" +
    "for(const el of document.querySelectorAll(" + JSON.stringify(CONTROL_SEL) + ")){" +
    "const t=(el.innerText||el.getAttribute('aria-label')||el.getAttribute('title')||el.value||'').trim().slice(0,60);if(!t)continue;" +
    "const r=el.getBoundingClientRect();if(!r.width||!r.height)continue;" +
    "out.controls.push({text:t,index:out.controls.length});if(out.controls.length>40)break;}" +
    "return out;})())";

  async function crawlLoop(s) {
    const c = s.crawl;
    const deadline = c.startedAt + c.budgetSeconds * 1000;
    while (c.running && c.queue.length && c.visited.length < c.maxPages) {
      if (Date.now() > deadline) {
        c.stoppedReason = "budgetSeconds exhausted";
        break;
      }
      const next = c.queue.shift();
      if (!next || c.visited.indexOf(next.url) !== -1) continue;
      if (next.depth > c.maxDepth) continue;

      c.currentUrl = next.url;
      c.visited.push(next.url);
      const seqBefore = s.seq;
      let page = { url: next.url, depth: next.depth, from: next.from || null, requests: [], error: null };
      try {
        await armNetwork(s.tabId);
        await chrome.tabs.update(s.tabId, { url: next.url });
        await waitForLoad(s.tabId, 20000);
        await waitForNetworkIdle(s, 800, 10000);
        const info = await evalJson(s.tabId, COLLECT_EXPR);
        if (info) {
          page.finalUrl = info.href;
          page.title = info.title;
          page.linkCount = (info.links || []).length;
          for (const l of info.links || []) {
            if (c.sameOriginOnly && !sameOrigin(l.href, next.url)) continue;
            if (DENY_RE.test(l.href) || DENY_RE.test(l.text || "")) {
              c.skipped.push({ url: l.href, why: "deny list" });
              continue;
            }
            if (c.denyPattern && new RegExp(c.denyPattern, "i").test(l.href)) {
              c.skipped.push({ url: l.href, why: "denyPattern" });
              continue;
            }
            const clean = l.href.split("#")[0];
            if (c.visited.indexOf(clean) !== -1 || c.queue.some((q) => q.url === clean)) continue;
            c.queue.push({ url: clean, depth: next.depth + 1, from: next.url });
          }
          for (const r of info.routes || []) {
            if (typeof r !== "string" || !r || r.indexOf(":") !== -1 || r.indexOf("*") !== -1) continue;
            if (DENY_RE.test(r)) continue;
            let abs;
            try {
              abs = new URL(r, next.url).href;
            } catch (e) {
              continue;
            }
            if (c.visited.indexOf(abs) !== -1 || c.queue.some((q) => q.url === abs)) continue;
            c.queue.push({ url: abs, depth: next.depth + 1, from: next.url + " (route table)" });
          }
          page.routesFound = (info.routes || []).length;

          if (c.interact && info.controls) {
            page.interacted = [];
            for (const ctl of info.controls.slice(0, c.maxClicks)) {
              if (!c.running) break;
              if (DENY_RE.test(ctl.text)) {
                c.skipped.push({ control: ctl.text, why: "deny list" });
                continue;
              }
              const before = s.seq;
              const result = await evalJson(s.tabId, clickExpr(ctl.index));
              if (!result || !result.ok) {
                page.interacted.push({ text: ctl.text, clicked: false, why: (result && result.why) || "click failed" });
                continue;
              }
              await waitForNetworkIdle(s, 600, 5000);
              const entry = { text: result.text, clicked: true, newRequests: s.seq - before };
              if (result.triedToClose) {
                entry.triedToCloseTab = true;
                c.skipped.push({ control: result.text, why: "called window.close() — blocked" });
              }
              // A click that navigates puts every later control on a different
              // page. Note it and go back, so the remaining clicks mean what
              // the collector said they meant.
              let where = null;
              try {
                where = await evalJson(s.tabId, "JSON.stringify(location.href)");
              } catch (e) {}
              if (where && typeof where === "string" && where.split("#")[0] !== (info.href || next.url).split("#")[0]) {
                entry.navigatedTo = where;
                const clean = where.split("#")[0];
                if (
                  (!c.sameOriginOnly || sameOrigin(clean, next.url)) &&
                  !DENY_RE.test(clean) &&
                  c.visited.indexOf(clean) === -1 &&
                  !c.queue.some((q) => q.url === clean)
                ) {
                  c.queue.push({ url: clean, depth: next.depth + 1, from: next.url + " (click: " + result.text + ")" });
                }
                try {
                  await chrome.tabs.update(s.tabId, { url: next.url });
                  await waitForLoad(s.tabId, 20000);
                  await waitForNetworkIdle(s, 600, 5000);
                } catch (e) {}
              }
              page.interacted.push(entry);
            }
            page.clicksFired = page.interacted.filter((x) => x.clicked).length;
            page.requestsFromClicks = page.interacted.reduce((n, x) => n + (x.newRequests || 0), 0);
          }
        }
        if (c.screenshot) {
          try {
            const shot = await deps.cdp(s.tabId, "Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
            if (shot && shot.data) {
              const name = "screenshots/" + String(c.visited.length).padStart(3, "0") + "-" + hash32(next.url) + ".png";
              queueWrite(s, name, { base64: shot.data });
              page.screenshot = name;
            }
          } catch (e) {}
        }
      } catch (e) {
        page.error = String((e && e.message) || e);
        // The tab is gone — closed, crashed, or discarded. Every remaining page
        // would fail identically, and the first version dutifully "visited" nine
        // of them: nine error entries in the route map, the whole budget spent,
        // and a routes.json that replaced a good one with junk.
        if (/no tab with/i.test(page.error)) {
          c.tabGone = true;
          c.stoppedReason =
            "the tab being crawled no longer exists (closed, crashed or discarded) after " +
            c.pages.length + " page(s) — nothing further could be visited";
        }
      }
      page.requests = s.index.filter((r) => r.seq > seqBefore).map((r) => r.seq);
      page.newRequests = s.seq - seqBefore;
      c.pages.push(page);
      queueWrite(s, "routes.json", { json: crawlReport(s) });
      await flush(s);
      if (c.tabGone) break;
    }
    c.running = false;
    c.finishedAt = Date.now();
    if (!c.stoppedReason) c.stoppedReason = c.queue.length ? "maxPages reached" : "queue exhausted";
    c.currentUrl = null;
    queueWrite(s, "routes.json", { json: crawlReport(s) });
    queueWrite(s, "session.json", { json: sessionSummary(s) });
    await flush(s);
  }

  function crawlReport(s) {
    const c = s.crawl || {};
    // Earlier runs ride along. routes.json is rewritten on every crawl, and an
    // interactive second pass over the same slug used to replace a 25-page map
    // with its own 12 — the requests were still there, but the route graph was
    // not.
    return {
      earlierRuns: s.crawlHistory || [],
      slug: s.slug,
      startedAt: c.startedAt ? new Date(c.startedAt).toISOString() : null,
      finishedAt: c.finishedAt ? new Date(c.finishedAt).toISOString() : null,
      running: !!c.running,
      stoppedReason: c.stoppedReason || null,
      settings: {
        maxPages: c.maxPages,
        maxDepth: c.maxDepth,
        sameOriginOnly: c.sameOriginOnly,
        budgetSeconds: c.budgetSeconds,
        interact: !!c.interact,
        screenshot: !!c.screenshot,
        denyPattern: c.denyPattern || null
      },
      visited: c.visited || [],
      queueRemaining: (c.queue || []).length,
      skipped: (c.skipped || []).slice(0, 200),
      pages: c.pages || []
    };
  }

  async function crawl(args) {
    // Snapshot the previous run before its state is replaced.
    {
      const prev = await getSession(args.slug, {});
      if (prev && prev.crawl && !prev.crawl.running && (prev.crawl.pages || []).length) {
        const hist = prev.crawlHistory || (prev.crawlHistory = []);
        if (hist.length < 10) {
          hist.push({
            startedAt: prev.crawl.startedAt,
            finishedAt: prev.crawl.finishedAt,
            stoppedReason: prev.crawl.stoppedReason,
            settings: {
              maxPages: prev.crawl.maxPages,
              maxDepth: prev.crawl.maxDepth,
              interact: prev.crawl.interact,
              budgetSeconds: prev.crawl.budgetSeconds
            },
            visited: prev.crawl.visited,
            pages: prev.crawl.pages
          });
        }
      }
    }

    if (!args.slug) return "Error: slug is required.";
    if (!args.tabId) return "Error: tabId is required. Use tabs_context_mcp to find it.";
    const s = await getSession(args.slug, { create: true, tabId: args.tabId });
    s.tabId = args.tabId;

    if (s.crawl && s.crawl.running) {
      return "A crawl is already running for '" + s.slug + "' (" + s.crawl.visited.length + " page(s) visited). Use api_capture action:'status' to watch it.";
    }
    // The crawler is only useful with capture running — the whole point is
    // which requests each route fires.
    if (!s.active) {
      const start = await captureStart({ slug: s.slug, tabId: args.tabId, resourceTypes: args.resourceTypes, bodyLimit: args.bodyLimit, urlPattern: args.urlPattern });
      s.autoStarted = start;
    }

    let seed = args.url;
    if (!seed) {
      const tab = await chrome.tabs.get(args.tabId);
      seed = tab && tab.url;
    }
    if (!seed || !/^https?:/i.test(seed)) return "Error: the tab is not on an http(s) page and no seed url was given.";

    s.crawl = {
      running: true,
      startedAt: Date.now(),
      finishedAt: null,
      maxPages: typeof args.maxPages === "number" ? args.maxPages : 25,
      maxDepth: typeof args.maxDepth === "number" ? args.maxDepth : 3,
      sameOriginOnly: args.sameOriginOnly !== false,
      budgetSeconds: typeof args.budgetSeconds === "number" ? args.budgetSeconds : 120,
      screenshot: args.screenshot !== false,
      interact: !!args.interact,
      maxClicks: typeof args.maxClicks === "number" ? args.maxClicks : 8,
      denyPattern: args.denyPattern || null,
      queue: [{ url: seed.split("#")[0], depth: 0, from: null }],
      visited: [],
      pages: [],
      skipped: [],
      currentUrl: null,
      stoppedReason: null
    };
    persist();

    // Deliberately not awaited: a 25-page crawl outlives the 60s tool-call
    // ceiling, so this returns immediately and progress is polled.
    crawlLoop(s).catch((e) => {
      s.crawl.running = false;
      s.crawl.stoppedReason = "error: " + String((e && e.message) || e);
    });

    return (
      "Crawl started for '" + s.slug + "' from " + seed + ".\n" +
      (s.autoStarted ? "(Capture was not running, so it was started first.)\n" : "") +
      "maxPages=" + s.crawl.maxPages + " maxDepth=" + s.crawl.maxDepth + " budgetSeconds=" + s.crawl.budgetSeconds +
      " sameOriginOnly=" + s.crawl.sameOriginOnly + " screenshot=" + s.crawl.screenshot + " interact=" + s.crawl.interact + "\n" +
      (s.crawl.interact
        ? "Interaction is ON: ordinary controls will be clicked in the user's live session. State-changing labels are still skipped.\n"
        : "Navigation only — no clicking.\n") +
      "This runs in the background because a crawl outlasts one tool call. Poll api_capture action:'status', " +
      "then api_capture action:'read' to see what it found. It writes routes.json and screenshots/ as it goes."
    );
  }

  async function crawlStop(slug) {
    const s = await getSession(slug);
    if (!s || !s.crawl) return "No crawl for '" + slug + "'.";
    s.crawl.running = false;
    s.crawl.stoppedReason = "stopped by request";
    return "Crawl for '" + slug + "' will stop after the page in flight.";
  }

  // ---- api_spec --------------------------------------------------------------

  async function spec(args) {
    if (!args.slug) return "Error: slug is required.";
    const s = await getSession(args.slug);
    // Worth spelling out, because the files are sitting right there on disk and
    // it looks like a bug: the spec is built from the in-memory index, and the
    // extension has no way to read back what it wrote. A service-worker
    // eviction is survivable (the index is mirrored to session storage), but
    // reloading the extension or restarting the browser clears that too.
    if (!s) {
      return (
        "No capture session named '" + args.slug + "' is in memory. If custom_apis/" + args.slug + "/requests/ " +
        "already has files, they were written by a session that has since gone (the extension was reloaded, or the " +
        "browser restarted) — the spec is synthesized from the in-memory index, not by re-reading the bundle, so the " +
        "capture has to be re-run: api_capture action:'start', drive the app or api_crawl, then api_spec."
      );
    }
    await flush(s);
    if (!s.index.length && !s.findings.length) {
      return "Nothing to synthesize for '" + s.slug + "' — no captured requests and no static findings. Run api_capture / api_crawl / api_scan_source first.";
    }

    let catalog = buildCatalog(s.index);
    const observedCount = catalog.length;
    let heldBack = 0;
    if (args.includeStatic !== false && s.findings.length) {
      catalog = mergeFindings(catalog, s.findings, { scoreFloor: typeof args.scoreFloor === "number" ? args.scoreFloor : undefined });
      heldBack = catalog.heldBack || 0;
    }
    const doc = toOpenApi(catalog, { title: (s.origins[0] || s.slug) + " API", staticFindings: s.findings.length });

    queueWrite(s, "endpoints.json", {
      json: { generatedAt: new Date().toISOString(), slug: s.slug, origins: s.origins, endpoints: catalog }
    });
    queueWrite(s, "openapi.json", { json: doc });
    await flush(s);

    const staticOnly = catalog.length - observedCount;
    const declaredCount = catalog.filter((e) => !e.observed && e.declared).length;
    const minedCount = staticOnly - declaredCount;
    const lines = catalog
      .slice(0, 60)
      .map(
        (e) =>
          "  " + (e.observed ? "" : e.declared ? "* " : "? ") + e.method + " " + e.path +
          (e.observed
            ? " (" + e.calls + " call(s), " + Object.keys(e.statuses).join("/") + ")"
            : e.declared
              ? " (declared in the app's own spec, never called)"
              : " (source only)") +
          (Object.keys(e.authHeaders).length ? " auth:" + Object.keys(e.authHeaders).join("+") : "")
      );
    return (
      "Wrote endpoints.json and openapi.json to " + (s.bundleDir || "the bundle") + ".\n" +
      observedCount + " endpoint(s) observed in traffic" +
      (declaredCount ? ", " + declaredCount + " declared in a spec the app publishes but never called from the UI (marked *)" : "") +
      (minedCount > 0 ? ", " + minedCount + " mined from source only (marked ? — leads, not facts)" : "") + ".\n" +
      (heldBack
        ? heldBack + " lower-confidence source finding(s) were left out of the spec to keep it usable; they are all in static/findings.json. Pass scoreFloor to change the cutoff.\n"
        : "") +
      lines.join("\n") + (catalog.length > 60 ? "\n  … " + (catalog.length - 60) + " more in endpoints.json" : "") + "\n" +
      "Write the Python client into " + (s.bundleDir || "the bundle") + "/client/ from openapi.json; auth.json has the live credentials it needs."
    );
  }

  // ---- api_probe -------------------------------------------------------------

  const SAFE_METHODS = ["GET", "HEAD", "OPTIONS"];

  // Replay a call. Default is from the page, because that inherits the origin,
  // the cookies and the CSP the real app runs under — a probe that succeeds
  // only from the service worker has proved nothing about the app.
  async function probe(args) {
    if (!args.slug) return "Error: slug is required.";
    if (!args.endpoint) return "Error: endpoint is required (a path, a full URL, or a #seq from api_capture action:'read').";
    const s = await getSession(args.slug);
    if (!s) return "No session named '" + args.slug + "'. Run api_capture action:'start' first.";
    const tabId = args.tabId || s.tabId;
    if (!tabId) return "Error: no tabId known for this session; pass one.";

    const method = String(args.method || "GET").toUpperCase();

    // Resolve the endpoint against what we captured so a bare path works and
    // the recorded headers can be reused.
    let ref = null;
    const m = /^#?(\d+)$/.exec(String(args.endpoint));
    if (m) ref = s.index.find((r) => r.seq === Number(m[1]));
    else ref = s.index.find((r) => r.url === args.endpoint) || s.index.find((r) => r.url.indexOf(args.endpoint) !== -1);

    let url = args.endpoint;
    if (ref) url = ref.url;
    else if (!/^https?:/i.test(url)) {
      const origin = s.origins[0];
      if (!origin) return "Error: '" + args.endpoint + "' is not a full URL and no origin is known for this session.";
      url = origin + (url[0] === "/" ? "" : "/") + url;
    }

    const headers = Object.assign({}, (ref && ref.authHeaders) || {}, args.headers || {});
    delete headers.cookie; // the browser attaches it; setting it from JS is a no-op

    const req = {
      url,
      method,
      headers,
      body: args.body === undefined || args.body === null ? null : typeof args.body === "string" ? args.body : JSON.stringify(args.body)
    };

    const runInPage = args.fromPage !== false;
    const results = { authenticated: null, unauthenticated: null };

    async function callFromPage(withCredentials) {
      const expr =
        "(async()=>{const t0=Date.now();try{const r=await fetch(" +
        JSON.stringify(req.url) +
        ",{method:" + JSON.stringify(req.method) +
        ",headers:" + JSON.stringify(withCredentials ? req.headers : {}) +
        (req.body ? ",body:" + JSON.stringify(req.body) : "") +
        ",credentials:" + JSON.stringify(withCredentials ? "include" : "omit") +
        "});const txt=await r.text();const h={};r.headers.forEach((v,k)=>{h[k]=v;});" +
        "return JSON.stringify({status:r.status,ok:r.ok,headers:h,ms:Date.now()-t0,body:txt.slice(0,20000),truncated:txt.length>20000});}" +
        "catch(e){return JSON.stringify({error:String(e&&e.message||e),ms:Date.now()-t0});}})()";
      return evalJson(tabId, expr);
    }

    async function callFromWorker(withCredentials) {
      const t0 = Date.now();
      try {
        const r = await fetch(req.url, {
          method: req.method,
          headers: withCredentials ? req.headers : {},
          body: req.body || undefined,
          credentials: withCredentials ? "include" : "omit",
          cache: "no-store"
        });
        const txt = await r.text();
        const h = {};
        r.headers.forEach((v, k) => {
          h[k] = v;
        });
        return { status: r.status, ok: r.ok, headers: h, ms: Date.now() - t0, body: txt.slice(0, 20000), truncated: txt.length > 20000 };
      } catch (e) {
        return { error: String((e && e.message) || e), ms: Date.now() - t0 };
      }
    }

    const call = runInPage ? callFromPage : callFromWorker;
    await deps.ensureAttached(tabId);
    results.authenticated = await call(true);
    // Only for safe methods: the point is to learn whether auth is required,
    // and repeating a write to find out is not a reasonable way to learn it.
    if (SAFE_METHODS.indexOf(method) !== -1) {
      results.unauthenticated = await call(false);
    }

    const a = results.authenticated || {};
    const u = results.unauthenticated;
    let verdict = "unknown";
    if (u && a.status && u.status) {
      if (a.ok && !u.ok) verdict = "auth REQUIRED (" + a.status + " with credentials, " + u.status + " without)";
      else if (a.ok && u.ok) verdict = "no auth needed (" + u.status + " without credentials too)";
      else verdict = "both failed (" + a.status + " / " + u.status + ")";
    }

    const probeRecord = {
      probedAt: new Date().toISOString(),
      request: req,
      via: runInPage ? "page context" : "service worker",
      basedOnCapturedRequest: ref ? ref.seq : null,
      results,
      authVerdict: verdict
    };
    queueWrite(s, "probes/" + Date.now() + "-" + hash32(method + url) + ".json", { json: probeRecord });
    await flush(s);

    return (
      method + " " + url + " via " + probeRecord.via + "\n" +
      (a.error ? "ERROR: " + a.error : "status " + a.status + " in " + a.ms + "ms" + (a.headers && a.headers["content-type"] ? " [" + a.headers["content-type"] + "]" : "")) + "\n" +
      (u ? "Auth check: " + verdict + "\n" : "Auth check skipped for " + method + " — it is not a safe method.\n") +
      (a.body ? "Body (" + (a.truncated ? "truncated to 20KB" : String(a.body.length) + " bytes") + "):\n" + a.body.slice(0, 4000) + (a.body.length > 4000 ? "\n… full body in the probes/ file" : "") : "") +
      "\nSaved to " + (s.bundleDir || "the bundle") + "/probes/."
    );
  }

  // ---------------------------------------------------------------------------

  // ---- api_hosts -------------------------------------------------------------

  // Run n at a time. A host inventory can hold a couple of hundred candidates
  // and firing them all at once is both rude and slower than it looks.
  async function mapLimit(items, n, fn) {
    const out = new Array(items.length);
    let i = 0;
    const workers = new Array(Math.min(n, items.length || 1)).fill(0).map(async () => {
      while (true) {
        const idx = i++;
        if (idx >= items.length) return;
        try {
          out[idx] = await fn(items[idx], idx);
        } catch (e) {
          out[idx] = { error: String((e && e.message) || e) };
        }
      }
    });
    await Promise.all(workers);
    return out;
  }

  async function fetchWithTimeout(url, opts, ms) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms || 8000);
    try {
      return await fetch(url, Object.assign({ signal: ctl.signal }, opts || {}));
    } finally {
      clearTimeout(timer);
    }
  }

  async function hosts(args) {
    if (!args.slug) return "Error: slug is required.";
    const s = await getSession(args.slug, { create: true, tabId: args.tabId });
    if (args.tabId) s.tabId = args.tabId;

    const found = new Map();
    const add = (host, source) => {
      if (!host) return;
      const h = String(host).toLowerCase().replace(/:\d+$/, "");
      if (!isPlausibleHost(h)) return;
      const entry = found.get(h) || { host: h, sources: [] };
      if (entry.sources.indexOf(source) === -1) entry.sources.push(source);
      found.set(h, entry);
    };

    // 1. Hosts the capture actually talked to.
    for (const r of s.index) {
      try {
        add(new URL(r.url).hostname, "traffic");
      } catch (e) {}
    }
    for (const o of s.origins || []) {
      try {
        add(new URL(o).hostname, "traffic");
      } catch (e) {}
    }

    // 2. Content-Security-Policy: the app's own allow-list of backends.
    for (const csp of s.cspSeen || []) for (const h of hostsFromCsp(csp)) add(h, "csp");

    // 3. Absolute URLs left in the JS bundles api_fetch_source pulled down.
    for (const src of s.sources || []) {
      for (const h of hostsFromText(src.text)) add(h, "script:" + src.name);
    }

    // 4. What the page itself declares it will connect to, plus everything it
    //    already loaded. dns-prefetch and preconnect hints in particular name
    //    API hosts before the first call is ever made.
    if (s.tabId) {
      try {
        const r = await deps.cdp(s.tabId, "Runtime.evaluate", {
          expression:
            "JSON.stringify({hints:Array.from(document.querySelectorAll('link[rel=dns-prefetch],link[rel=preconnect],link[rel=preload]')).map(x=>x.href)," +
            "res:performance.getEntriesByType('resource').map(e=>e.name)," +
            "meta:Array.from(document.querySelectorAll('meta[http-equiv=\\'Content-Security-Policy\\']')).map(x=>x.content)})",
          returnByValue: true
        });
        const page = JSON.parse((r && r.result && r.result.value) || "{}");
        for (const u of page.hints || []) {
          try {
            add(new URL(u).hostname, "page-hint");
          } catch (e) {}
        }
        for (const u of page.res || []) {
          try {
            add(new URL(u).hostname, "page-resource");
          } catch (e) {}
        }
        for (const c of page.meta || []) for (const h of hostsFromCsp(c)) add(h, "csp");
      } catch (e) {}
    }

    // Scope. Everything above is unfiltered; the domain decides what counts as
    // "this site's" host versus somebody's CDN.
    let domain = args.domain ? String(args.domain).replace(/^\*?\.?/, "").toLowerCase() : null;
    if (!domain) {
      const seed = s.primaryOrigin || (s.origins && s.origins[0]) || null;
      if (seed) {
        try {
          domain = baseDomain(new URL(seed).hostname);
        } catch (e) {}
      }
    }
    if (!domain && s.tabId) {
      try {
        const r = await deps.cdp(s.tabId, "Runtime.evaluate", {
          expression: "location.hostname",
          returnByValue: true
        });
        domain = baseDomain(String((r && r.result && r.result.value) || ""));
      } catch (e) {}
    }
    if (!domain) return "Error: no domain to scope to. Pass domain, or give a tabId / start a capture first.";

    // 5. robots.txt and sitemap.xml, which routinely name hosts the site never
    //    links to from its own pages.
    const roots = [];
    for (const o of s.origins || []) roots.push(o);
    if (!roots.length) roots.push("https://" + domain);
    const docFetches = [];
    for (const root of roots.slice(0, 4)) {
      for (const f of ["/robots.txt", "/sitemap.xml", "/sitemap_index.xml", "/security.txt", "/.well-known/security.txt"]) {
        docFetches.push(root.replace(/\/$/, "") + f);
      }
    }
    const docHits = [];
    await mapLimit(docFetches, 5, async (u) => {
      const res = await fetchWithTimeout(u, { credentials: "omit", cache: "no-store" }, 6000);
      if (!res.ok) return null;
      const text = (await res.text()).slice(0, 400000);
      if (/<html/i.test(text.slice(0, 400))) return null; // a soft-404 page
      docHits.push({ url: u, bytes: text.length });
      for (const h of hostsFromText(text)) add(h, "robots/sitemap");
      return null;
    });

    // 6. Certificate Transparency. Off by default: it asks a third party about
    //    the target, which is a disclosure the caller should opt into rather
    //    than discover afterwards. It is also the only source here that finds
    //    hosts nothing in the app mentions at all.
    //
    //    Two logs, queried in parallel and merged. certspotter answers in under
    //    a second; crt.sh is more thorough historically but routinely takes
    //    half a minute, which is most of the 60s tool ceiling — so neither is
    //    allowed to be the single point of failure.
    let ctNote = "certificate transparency not queried (pass ct: true — note it discloses the domain to a third-party log)";
    if (args.ct === true) {
      const notes = [];
      const collect = (name, hostList) => {
        let n = 0;
        for (const raw of hostList) {
          const h = String(raw || "").trim().toLowerCase().replace(/^\*\./, "");
          if (!h || !inDomain(h, domain)) continue;
          add(h, name);
          n++;
        }
        return n;
      };
      await Promise.all([
        (async () => {
          try {
            const res = await fetchWithTimeout(
              "https://api.certspotter.com/v1/issuances?domain=" + encodeURIComponent(domain) +
                "&include_subdomains=true&expand=dns_names",
              { credentials: "omit", cache: "no-store" },
              12000
            );
            if (!res.ok) {
              notes.push("certspotter HTTP " + res.status + (res.status === 429 ? " (rate limited — it is free and unauthenticated)" : ""));
              return;
            }
            const rows = JSON.parse(await res.text());
            const names = [];
            for (const row of Array.isArray(rows) ? rows : []) {
              for (const n of row.dns_names || []) names.push(n);
            }
            notes.push("certspotter: " + collect("certspotter", names) + " in-domain name(s)");
          } catch (e) {
            notes.push("certspotter failed: " + String((e && e.message) || e));
          }
        })(),
        (async () => {
          try {
            const res = await fetchWithTimeout(
              "https://crt.sh/?q=%25." + encodeURIComponent(domain) + "&output=json",
              { credentials: "omit", cache: "no-store" },
              35000
            );
            if (!res.ok) {
              notes.push("crt.sh HTTP " + res.status);
              return;
            }
            const rows = JSON.parse(await res.text());
            const names = [];
            for (const row of Array.isArray(rows) ? rows : []) {
              for (const n of String(row.name_value || "").split(/\n+/)) names.push(n);
            }
            notes.push("crt.sh: " + collect("crt.sh", names) + " in-domain name(s) from " + (Array.isArray(rows) ? rows.length : 0) + " cert(s)");
          } catch (e) {
            // Expected often enough to be worth saying plainly rather than
            // reporting an empty inventory as if the logs were clean.
            notes.push("crt.sh timed out or failed (it is slow; certspotter above still counts): " + String((e && e.message) || e));
          }
        })()
      ]);
      ctNote = notes.join("; ");
    }

    const all = Array.from(found.values());
    for (const e of all) e.inDomain = inDomain(e.host, domain);
    const scoped = all.filter((e) => e.inDomain).sort((a, b) => a.host.localeCompare(b.host));
    const external = all.filter((e) => !e.inDomain).sort((a, b) => a.host.localeCompare(b.host));

    // 7. Liveness. A GET to the root of each in-scope host, which is what a
    //    browser would do if the user typed it. Off by default because a host
    //    list is useful on its own and this is the only step that touches
    //    infrastructure nothing has asked for yet.
    let probeNote = "not probed (pass probe: true to GET each in-scope host's root and report what answers)";
    if (args.probe === true) {
      const limit = typeof args.limit === "number" ? args.limit : 60;
      const targets = scoped.slice(0, limit);
      await mapLimit(targets, 6, async (e) => {
        try {
          const res = await fetchWithTimeout("https://" + e.host + "/", { credentials: "omit", redirect: "manual", cache: "no-store" }, 8000);
          e.live = true;
          // An opaque redirect has status 0 and no readable headers. It still
          // proves the host answers, which is the thing being asked.
          e.opaqueRedirect = res.type === "opaqueredirect" || (res.status === 0 && res.type !== "error");
          e.status = e.opaqueRedirect ? "redirect" : res.status;
          e.server = res.headers.get("server") || null;
          const loc = res.headers.get("location");
          if (loc) e.redirectsTo = loc.slice(0, 200);
          const ct = res.headers.get("content-type") || "";
          e.looksLikeApi = /json|xml|grpc/i.test(ct) || /^(api|graphql|gateway|rest)\b/.test(e.host);
        } catch (err) {
          e.live = false;
          e.error = String((err && err.message) || err).slice(0, 120);
        }
        return null;
      });
      const up = targets.filter((t) => t.live).length;
      probeNote =
        "probed " + targets.length + " in-scope host(s): " + up + " answered" +
        (scoped.length > limit ? ", " + (scoped.length - limit) + " not probed (limit)" : "");
    }

    s.hosts = { domain, scoped, external };
    await getSession(args.slug, {});
    queueWrite(s, "hosts.json", {
      json: {
        slug: args.slug,
        domain,
        generatedAt: new Date().toISOString(),
        sourcesUsed: ["traffic", "csp", "script", "page-hint", "page-resource", "robots/sitemap"].concat(args.ct === true ? ["crt.sh"] : []),
        documentsFound: docHits,
        inDomain: scoped,
        external
      }
    });
    await flush(s);

    const lines = [];
    lines.push("Wrote hosts.json to " + (s.bundleDir || "custom_apis/" + args.slug) + ".");
    lines.push(
      scoped.length + " host(s) in " + domain + ", " + external.length + " external host(s) seen. " + ctNote + ". " + probeNote + "."
    );
    for (const e of scoped.slice(0, 80)) {
      lines.push(
        "  " + e.host +
          (e.live === true ? " [" + (e.opaqueRedirect ? "redirect" : e.status) + (e.server ? " " + e.server : "") + "]" : e.live === false ? " [no answer]" : "") +
          (e.looksLikeApi ? " (looks like an API host)" : "") +
          " via " + e.sources.slice(0, 3).join(",")
      );
    }
    if (scoped.length > 80) lines.push("  … " + (scoped.length - 80) + " more in hosts.json");
    if (!s.index.length && !(s.sources || []).length) {
      lines.push(
        "Only the page and its public files were available here. Run api_capture and api_fetch_source " +
          "first and the CSP and bundle sources kick in, which is where most backend hosts come from."
      );
    }
    lines.push("Next: api_wellknown to ask each host for a spec it publishes, or api_capture on one of them.");
    return lines.join("\n");
  }

  // ---- api_wellknown ---------------------------------------------------------

  // Paths that, when they answer, hand over the entire API surface at once —
  // including every endpoint the UI has no button for. Cheap to try and the
  // highest-value discovery step in the whole toolset when it lands.
  const WELL_KNOWN_PATHS = [
    "/openapi.json",
    "/openapi.yaml",
    "/swagger.json",
    "/swagger/v1/swagger.json",
    "/swagger/docs/v1",
    "/v2/api-docs",
    "/v3/api-docs",
    "/api-docs",
    "/api/openapi.json",
    "/api/swagger.json",
    "/api/v1/openapi.json",
    "/api/schema/",
    "/api/schema.json",
    "/.well-known/openapi.json",
    "/docs/openapi.json",
    "/redoc.json",
    "/apispec_1.json",
    "/spec.json",
    "/openapi",
    "/api/v3/openapi.json",
    "/v2/swagger.json",
    "/graphql/schema.json"
  ];

  const INTROSPECTION_QUERY =
    "query IntrospectionQuery{__schema{queryType{name}mutationType{name}" +
    "types{kind name fields(includeDeprecated:true){name args{name type{kind name ofType{kind name}}}" +
    "type{kind name ofType{kind name}}}}}}";

  async function wellKnown(args) {
    if (!args.slug) return "Error: slug is required.";
    const s = await getSession(args.slug, { create: true, tabId: args.tabId });
    if (args.tabId) s.tabId = args.tabId;

    // Which origins to ask. Explicit wins; then the hosts api_hosts found that
    // look like API hosts; then whatever the capture saw.
    let origins = [];
    if (args.origin) origins = [String(args.origin).replace(/\/$/, "")];
    else if (args.useHosts === true && s.hosts) {
      origins = s.hosts.scoped
        .filter((h) => h.live !== false)
        .slice(0, typeof args.limit === "number" ? args.limit : 25)
        .map((h) => "https://" + h.host);
    } else origins = (s.origins || []).slice();
    if (!origins.length) {
      return (
        "Error: no origin to ask. Pass origin, or run api_capture (which records the origins it saw), " +
          "or run api_hosts then pass useHosts: true."
      );
    }

    const targets = [];
    for (const o of origins) for (const path of WELL_KNOWN_PATHS) targets.push(o + path);

    const hits = [];
    let tried = 0;
    let skipped = 0;
    // The tool call has a 60s ceiling and a site that stalls on every unknown
    // path will happily use all of it. Stop starting new probes at 32s and say
    // how many were not tried, rather than being killed mid-sweep with nothing
    // to show.
    const deadline = Date.now() + 32000;
    await mapLimit(targets, 8, async (url) => {
      if (Date.now() > deadline) {
        skipped++;
        return null;
      }
      tried++;
      let res;
      try {
        res = await fetchWithTimeout(url, { credentials: "include", cache: "no-store" }, 5000);
      } catch (e) {
        return null;
      }
      if (!res.ok) return null;
      const text = (await res.text()).slice(0, 8e6);
      // A SPA answers 200 with its index.html for every unknown path, so status
      // alone proves nothing. The document has to actually parse and declare paths.
      let doc = null;
      try {
        doc = JSON.parse(text);
      } catch (e) {
        return null;
      }
      if (!doc || typeof doc !== "object" || !doc.paths) return null;
      const version = doc.openapi || doc.swagger || "?";
      const name = "wellknown/" + hash32(url) + "-" + (url.split("/").pop() || "spec").replace(/[^A-Za-z0-9._-]/g, "-").replace(/\.(json|yaml|yml)$/i, "") + ".json";
      queueWrite(s, name, { text: text });
      const findings = openApiToFindings(doc, name, url);
      for (const f of findings) f.score = scoreFinding(f);
      (s.findings || (s.findings = [])).push.apply(s.findings, findings);
      hits.push({
        url,
        version,
        title: (doc.info && doc.info.title) || null,
        pathCount: Object.keys(doc.paths).length,
        operationCount: findings.length,
        file: name
      });
      return null;
    });

    // GraphQL introspection. A POST, so it goes behind the same force gate as
    // api_probe — the query itself only reads the schema, but the house rule is
    // that this tool does not send a non-GET at a live app unattended.
    let gqlNote = "GraphQL introspection not attempted (pass graphql: true, which needs force: true — it is a POST).";
    if (args.graphql === true) {
      if (args.force !== true) {
        gqlNote =
          "Refusing to POST a GraphQL introspection query without force: true. The query only reads the " +
          "schema, but it is still an unattended POST at a live app. Ask the user first, then retry with force: true.";
      } else {
        const gqlTargets = [];
        for (const o of origins) for (const pth of ["/graphql", "/api/graphql", "/graphql/v1", "/query", "/gql"]) gqlTargets.push(o + pth);
        const gqlHits = [];
        await mapLimit(gqlTargets, 4, async (url) => {
          let res;
          try {
            res = await fetchWithTimeout(
              url,
              {
                method: "POST",
                credentials: "include",
                cache: "no-store",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ query: INTROSPECTION_QUERY })
              },
              12000
            );
          } catch (e) {
            return null;
          }
          const text = (await res.text()).slice(0, 8e6);
          let doc = null;
          try {
            doc = JSON.parse(text);
          } catch (e) {
            return null;
          }
          const schema = doc && doc.data && doc.data.__schema;
          if (!schema) return null;
          const file = "wellknown/graphql-" + hash32(url) + ".json";
          queueWrite(s, file, { text: text });
          const types = (schema.types || []).filter((t) => t && t.name && t.name.indexOf("__") !== 0);
          const queryType = schema.queryType && schema.queryType.name;
          const mutationType = schema.mutationType && schema.mutationType.name;
          const countFields = (n) => {
            const t = types.filter((x) => x.name === n)[0];
            return (t && t.fields && t.fields.length) || 0;
          };
          gqlHits.push({
            url,
            file,
            types: types.length,
            queries: queryType ? countFields(queryType) : 0,
            mutations: mutationType ? countFields(mutationType) : 0
          });
          (s.findings || (s.findings = [])).push({
            kind: "openapi-doc",
            value: url,
            method: "POST",
            file,
            index: 0,
            context: "GraphQL endpoint, introspection succeeded: " + types.length + " type(s)",
            declared: true,
            score: 14
          });
          return null;
        });
        gqlNote = gqlHits.length
          ? "GraphQL introspection succeeded at " +
            gqlHits.map((g) => g.url + " (" + g.queries + " queries, " + g.mutations + " mutations, " + g.types + " types → " + g.file + ")").join("; ")
          : "GraphQL introspection found nothing at " + gqlTargets.length + " candidate path(s) — either no GraphQL here, or introspection is disabled (normal in production).";
      }
    }

    await flush(s);
    const lines = [];
    if (!hits.length) {
      lines.push(
        "No machine-readable spec published. Tried " + tried + " well-known path(s) across " + origins.length +
          " origin(s); nothing returned a parseable document with a paths object." +
          (skipped ? " " + skipped + " path(s) were not tried — the site answered too slowly to finish inside the time budget." : "")
      );
    } else {
      lines.push(
        "Found " + hits.length + " published spec(s) — these describe endpoints the UI may never call:"
      );
      for (const h of hits) {
        lines.push(
          "  " + h.url + " (" + (h.title || "untitled") + ", " + h.version + ") " + h.pathCount +
            " path(s), " + h.operationCount + " operation(s) → " + h.file
        );
      }
      lines.push(
        "Their operations were added to this session's findings at high confidence, so api_spec now merges " +
          "them with the observed traffic. Run api_spec next." +
          (skipped ? " " + skipped + " further path(s) went untried on the time budget." : "")
      );
    }
    lines.push(gqlNote);
    return lines.join("\n");
  }

  self.ApiMap = {
    init,
    onDebuggerEvent,
    onDebuggerDetach,
    capture,
    fetchSource,
    scanSource,
    crawl,
    crawlStop,
    spec,
    probe,
    hosts,
    wellKnown,
    // Exposed for the offline unit tests; nothing in the extension calls these.
    pure: {
      templatePath,
      declaredTemplate,
      segmentKind,
      singularize,
      camel,
      inferJsonSchema,
      mergeSchema,
      mineSourceForEndpoints,
      looksLikeRoute,
      buildCatalog,
      mergeFindings,
      shapeKey,
      scoreFinding,
      SPEC_SCORE_FLOOR,
      toOpenApi,
      hash32,
      scriptFileName,
      pickAuthHeaders,
      isFirstParty,
      baseDomain,
      parseJsonMaybe,
      hostsFromText,
      hostsFromCsp,
      isPlausibleHost,
      inDomain,
      openApiToFindings,
      WELL_KNOWN_PATHS,
      DENY_RE
    }
  };
})();
