/*
 * Locus Maths — Cloudflare Worker
 * -------------------------------------------------------------
 * Serves the static site (via the ASSETS binding) and adds one
 * server-side endpoint, POST /api/tutor, which proxies the AI
 * tutor to OpenAI or Anthropic. The provider API key lives ONLY
 * as a Worker secret (OPENAI_API_KEY / ANTHROPIC_API_KEY), never
 * in the client. The full reply is returned as plain text.
 *
 * Safeguards: origin lock (browser calls must come from our site),
 * strict size caps on input, and a graceful "not configured" state
 * when a key is missing. Rate limiting is handled at the edge by a
 * Cloudflare Rate Limiting Rule on /api/tutor, and the hard ceiling
 * is the spending cap set on each provider account.
 */

const ALLOWED_HOSTS = ["locusmaths.com", "www.locusmaths.com"];

function hostOf(u) { try { return new URL(u).host; } catch (e) { return ""; } }
function allowedHost(h) {
  if (!h) return false;
  if (ALLOWED_HOSTS.indexOf(h) !== -1) return true;
  if (h.endsWith(".workers.dev")) return true;            // Cloudflare preview deployments
  if (h === "localhost" || h === "127.0.0.1") return true;
  if (h.indexOf("localhost:") === 0 || h.indexOf("127.0.0.1:") === 0) return true;
  return false;
}

function json(obj, status, extra) {
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: Object.assign({ "Content-Type": "application/json", "Cache-Control": "no-store" }, extra || {})
  });
}

function textReply(text, ch) {
  return new Response(text, {
    status: 200,
    headers: Object.assign({ "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }, ch)
  });
}

function corsFor(origin) {
  const h = hostOf(origin);
  const allow = (origin && allowedHost(h)) ? origin : ("https://" + ALLOWED_HOSTS[0]);
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/tutor") {
      return handleTutor(request, env);
    }
    // Everything else is the static site.
    return env.ASSETS.fetch(request);
  }
};

async function handleTutor(request, env) {
  const origin = request.headers.get("Origin") || "";
  const ch = corsFor(origin);

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: ch });
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, ch);

  // Origin lock: block other websites calling us from a browser.
  // (A present Origin/Referer must point at our site; absent = allow, since
  // rate limiting + the spending cap are the real protection against scripts.)
  const ref = request.headers.get("Referer") || "";
  if (origin) {
    if (!allowedHost(hostOf(origin))) return json({ error: "forbidden", message: "The tutor can only be used from locusmaths.com." }, 403, ch);
  } else if (ref) {
    if (!allowedHost(hostOf(ref))) return json({ error: "forbidden", message: "The tutor can only be used from locusmaths.com." }, 403, ch);
  }

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "bad_request" }, 400, ch); }

  let provider = body.provider;
  if (provider !== "openai" && provider !== "anthropic") provider = env.DEFAULT_PROVIDER || "openai";

  const system = (typeof body.system === "string") ? body.system.slice(0, 8000) : "";

  let messages = Array.isArray(body.messages) ? body.messages : [];
  messages = messages.map(function (m) {
    return {
      role: (m && m.role === "assistant") ? "assistant" : "user",
      content: (m && typeof m.content === "string") ? m.content.slice(0, 6000) : ""
    };
  });
  if (messages.length > 14) messages = messages.slice(messages.length - 14);
  // Must start with a user message (providers require it / strict alternation).
  while (messages.length && messages[0].role !== "user") messages.shift();
  if (messages.length === 0) return json({ error: "no_messages" }, 400, ch);

  let image = null;
  if (body.image && typeof body.image.data === "string") {
    const mt = /^image\/(png|jpe?g|webp|gif)$/.test(body.image.media_type || "") ? body.image.media_type : "image/jpeg";
    image = { media_type: mt, data: body.image.data.slice(0, 8000000) }; // ~6MB decoded ceiling
  }

  try {
    if (provider === "anthropic") return await callAnthropic(env, ch, system, messages, image);
    return await callOpenAI(env, ch, system, messages, image);
  } catch (e) {
    return json({ error: "upstream_error", message: "Something went wrong reaching the tutor.", detail: String((e && e.message) || e) }, 502, ch);
  }
}

async function callOpenAI(env, ch, system, messages, image) {
  const key = env.OPENAI_API_KEY;
  if (!key) return json({ error: "not_configured", message: "The tutor isn't switched on just yet." }, 503, ch);
  const model = env.OPENAI_MODEL || "gpt-4o-mini";

  const oa = [{ role: "system", content: system }];
  messages.forEach(function (m, i) {
    const last = (i === messages.length - 1);
    if (last && image && m.role === "user") {
      oa.push({ role: "user", content: [
        { type: "text", text: m.content || "Here is my working." },
        { type: "image_url", image_url: { url: "data:" + image.media_type + ";base64," + image.data } }
      ]});
    } else {
      oa.push({ role: m.role, content: m.content });
    }
  });

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ model: model, max_tokens: 600, temperature: 0.4, messages: oa })
  });

  const data = await res.json().catch(function () { return null; });
  if (!res.ok || !data) {
    const msg = (data && data.error && data.error.message) || ("OpenAI returned status " + res.status);
    return json({ error: "openai_error", status: res.status, message: "The tutor had a problem: " + msg }, 502, ch);
  }
  const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!text) {
    const fr = (data.choices && data.choices[0] && data.choices[0].finish_reason) || "unknown";
    return json({ error: "empty_reply", message: "The tutor came back empty (finish: " + fr + ").", raw: data }, 502, ch);
  }
  return textReply(text, ch);
}

async function callAnthropic(env, ch, system, messages, image) {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) return json({ error: "not_configured", message: "The tutor isn't switched on just yet." }, 503, ch);
  const model = env.ANTHROPIC_MODEL || "claude-3-5-haiku-latest";

  const am = messages.map(function (m, i) {
    const last = (i === messages.length - 1);
    if (last && image && m.role === "user") {
      return { role: "user", content: [
        { type: "image", source: { type: "base64", media_type: image.media_type, data: image.data } },
        { type: "text", text: m.content || "Here is my working." }
      ]};
    }
    return { role: m.role, content: m.content };
  });

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({ model: model, max_tokens: 600, system: system, messages: am })
  });

  const data = await res.json().catch(function () { return null; });
  if (!res.ok || !data) {
    const msg = (data && data.error && data.error.message) || ("Anthropic returned status " + res.status);
    return json({ error: "anthropic_error", status: res.status, message: "The tutor had a problem: " + msg }, 502, ch);
  }
  let text = "";
  if (Array.isArray(data.content)) {
    for (let i = 0; i < data.content.length; i++) {
      if (data.content[i] && data.content[i].type === "text") text += data.content[i].text;
    }
  }
  if (!text) {
    return json({ error: "empty_reply", message: "The tutor came back empty.", raw: data }, 502, ch);
  }
  return textReply(text, ch);
}
