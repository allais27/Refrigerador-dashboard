// Cloudflare Worker — Proxy a OpenRouter (CORS + fallback)
// Endpoints: 
//   GET  /health     -> sanity check
//   GET  /models     -> lista de modelos OpenRouter
//   POST /chat       -> proxy a /chat/completions (formato OpenAI)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, HTTP-Referer, X-Title",
  "Access-Control-Max-Age": "86400",
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...CORS, ...extra },
  });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    // Sanity check
    if (req.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        proxy: "openrouter-proxy",
        default_model: env.DEFAULT_MODEL || "openrouter/auto",
      });
    }

    // Lista de modelos (útil para debug)
    if (req.method === "GET" && url.pathname === "/models") {
      if (!env.OR_API_KEY) return json({ ok:false, error:"Missing OR_API_KEY" }, 500);
      const r = await fetch(`${env.OPENROUTER_BASE || "https://openrouter.ai/api/v1"}/models`, {
        headers: { Authorization: `Bearer ${env.OR_API_KEY}` },
      });
      return new Response(r.body, {
        status: r.status,
        headers: { ...CORS, "content-type": r.headers.get("content-type") || "application/json" },
      });
    }

    // Chat completions
   if (req.method === "POST" && url.pathname === "/chat") {
  if (!env.OR_API_KEY) return json({ ok:false, error:"Missing OR_API_KEY" }, 500);

  let body; try { body = await req.json(); } catch { return json({ ok:false, error:"Invalid JSON body" }, 400); }

  const base = env.OPENROUTER_BASE || "https://openrouter.ai/api/v1";
  const payload = {
    model: body.model ?? env.DEFAULT_MODEL ?? "openrouter/auto",
    messages: body.messages ?? [{ role: "user", content: "Hola" }],
    ...Object.fromEntries(Object.entries(body).filter(([k]) => !["model","messages"].includes(k))),
  };
  const headers = {
    Authorization: `Bearer ${env.OR_API_KEY}`,
    "Content-Type": "application/json",
    "HTTP-Referer": body.referer || req.headers.get("Origin") || "https://workers.dev",
    "X-Title": body.title || "OpenRouter Worker",
  };

  // 1) Primer intento
  let r = await fetch(`${base}/chat/completions`, { method:"POST", headers, body: JSON.stringify(payload) });
  let txt = await r.text();

  // Detectar rate-limit/errores aunque HTTP=200
  const looksBad = (status, s) => status === 429 || /"ok"\s*:\s*false/.test(s) || /rate[- ]limited/i.test(s) || /code"\s*:\s*429/.test(s);

  if (looksBad(r.status, txt)) {
    // 2) Fallback a openrouter/auto
    const fb = { ...payload, model: "openrouter/auto" };
    r = await fetch(`${base}/chat/completions`, { method:"POST", headers, body: JSON.stringify(fb) });
    txt = await r.text();
  }

  return new Response(txt, {
    status: r.status,
    headers: { ...CORS, "content-type": r.headers.get("content-type") || "application/json" },
  });
}


    // Ruta no encontrada
    return json({ ok:false, error:"Use POST /chat o GET /models /health" }, 404);
  },
};
