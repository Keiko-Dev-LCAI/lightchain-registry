import { SEED, BLOCKED_IDS } from "./seed.js";

const FEE_LCAI_WEI = "1000000000000000000"; // 1 LCAI — adjustable ≈ $1 constant, no oracle
const VERIFY_PATH = "/.well-known/lightchain-app-verify.json";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, mcp-session-id",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "cache-control": "public, max-age=60",
    },
  });
}

function isBlocked(id) {
  return BLOCKED_IDS.has(String(id || "").toLowerCase().trim());
}

async function loadSubmitted(env) {
  if (!env.REGISTRY_KV) return [];
  const raw = await env.REGISTRY_KV.get("submitted");
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function mergeCatalog(submitted) {
  const byId = new Map();
  for (const app of submitted) {
    if (!app?.id || isBlocked(app.id)) continue;
    if (app.verified === false || app.status === "unhealthy") continue;
    byId.set(app.id, app);
  }
  for (const app of SEED) {
    if (isBlocked(app.id)) continue;
    byId.set(app.id, app);
  }
  return [...byId.values()];
}

function filterApps(apps, q) {
  return apps.filter((a) => {
    if (q.category && a.category !== q.category) return false;
    if (q.owner && a.owner !== q.owner) return false;
    if (q.status && a.status !== q.status) return false;
    const kind = a.payment?.kind;
    const kinds = a.payment?.kinds || (kind ? [kind] : []);
    if (q.kind && kind !== q.kind && !kinds.includes(q.kind)) return false;
    return true;
  });
}

function catalogDoc(apps) {
  return {
    name: "Lightchain Agent Registry",
    version: "1",
    chainId: 9200,
    rpcUrl: "https://rpc.mainnet.lightchain.ai",
    onramp: "https://bridge.lightchain.ai/",
    nativeCurrency: { symbol: "LCAI", decimals: 18 },
    updated: new Date().toISOString(),
    apps,
  };
}

async function rpc(method, params) {
  const r = await fetch("https://rpc.mainnet.lightchain.ai", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "rpc error");
  return j.result;
}

async function checkUrl(url) {
  if (!url || !/^https:\/\//i.test(url)) return { ok: false, error: "url must be https" };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { method: "GET", redirect: "follow", signal: ctrl.signal });
    return { ok: r.status >= 200 && r.status < 400, status: r.status };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

function validListing(body) {
  const errs = [];
  if (!body || typeof body !== "object") return ["body must be a JSON object"];
  if (!body.id || !/^[a-z0-9-]{2,64}$/.test(body.id)) errs.push("id must be slug a-z0-9-");
  if (isBlocked(body.id)) errs.push("id is not allowed");
  if (!body.name) errs.push("name required");
  if (!body.url || !/^https:\/\//i.test(body.url)) errs.push("https url required");
  if (body.chainId !== 9200) errs.push("chainId must be 9200");
  const kind = body.payment?.kind;
  const allowed = ["aivm_allowance", "native_transfer", "app_token", "free", "human_only", "unknown"];
  if (!kind || !allowed.includes(kind)) errs.push("payment.kind invalid");
  if (!["keikodev", "protocol", "community"].includes(body.owner)) errs.push("owner must be keikodev|protocol|community");
  if (!body.endpoint || !/^https:\/\//i.test(body.endpoint)) errs.push("https endpoint required for submit");
  if (!body.healthUrl || !/^https:\/\//i.test(body.healthUrl)) errs.push("https healthUrl required");
  return errs;
}

async function verifyWellKnown(listing) {
  let origin;
  try {
    origin = new URL(listing.url).origin;
  } catch {
    return { ok: false, error: "bad url" };
  }
  const verifyUrl = origin + VERIFY_PATH;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(verifyUrl, { signal: ctrl.signal });
    if (!r.ok) return { ok: false, error: "verify file missing", verifyUrl };
    const j = await r.json();
    if (j.id !== listing.id) return { ok: false, error: "verify id mismatch", verifyUrl };
    if (j.url && j.url.replace(/\/$/, "") !== listing.url.replace(/\/$/, "")) {
      return { ok: false, error: "verify url mismatch", verifyUrl };
    }
    return { ok: true, verifyUrl };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

async function verifySignature(listing, proof) {
  const address = (proof?.address || "").toLowerCase();
  const sig = proof?.signature;
  if (!sig || !address || !/^0x[0-9a-f]{40}$/.test(address)) {
    return { ok: false, error: "signature proof needs address + signature" };
  }
  if (listing.wallet && listing.wallet.toLowerCase() !== address) {
    return { ok: false, error: "wallet does not match signature address" };
  }
  return { ok: true, address, note: "fee tx sender must match this address" };
}

async function verifyFee(env, txHash, expectedFrom) {
  const wallet = (env.SUBMISSION_WALLET || "").trim();
  if (!wallet || wallet === "SET_ME" || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    return { ok: false, error: "SUBMISSION_WALLET is not configured" };
  }
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return { ok: false, error: "feeTxHash required" };
  }
  if (env.REGISTRY_KV) {
    const used = await env.REGISTRY_KV.get("fee:" + txHash.toLowerCase());
    if (used) return { ok: false, error: "fee tx already used" };
  }
  const tx = await rpc("eth_getTransactionByHash", [txHash]);
  if (!tx) return { ok: false, error: "fee tx not found" };
  const receipt = await rpc("eth_getTransactionReceipt", [txHash]);
  if (!receipt || receipt.status !== "0x1") return { ok: false, error: "fee tx failed" };
  if ((tx.to || "").toLowerCase() !== wallet.toLowerCase()) {
    return { ok: false, error: "fee tx not sent to SUBMISSION_WALLET" };
  }
  const value = BigInt(tx.value || "0x0");
  if (value < BigInt(FEE_LCAI_WEI)) return { ok: false, error: "fee below 1 LCAI" };
  if (expectedFrom && (tx.from || "").toLowerCase() !== expectedFrom.toLowerCase()) {
    return { ok: false, error: "fee tx sender must match proof address" };
  }
  return { ok: true, wallet, value: value.toString() };
}

async function handleSubmit(req, env) {
  if (req.method !== "POST") {
    return json({
      submit: "POST JSON",
      proof: "well-known file at " + VERIFY_PATH + " OR wallet signature + fee from that wallet",
      fee: { amountWei: FEE_LCAI_WEI, token: "native LCAI", to: env.SUBMISSION_WALLET || "SET_ME" },
      chainId: 9200,
    });
  }
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  const listing = body.listing || body;
  const errs = validListing(listing);
  if (errs.length) return json({ error: "invalid listing", errs }, 400);

  const health = await checkUrl(listing.healthUrl);
  const endpoint = await checkUrl(listing.endpoint);
  if (!health.ok) return json({ error: "healthUrl did not respond", health }, 400);
  if (!endpoint.ok) return json({ error: "endpoint did not respond", endpoint }, 400);

  const proof = body.proof || {};
  let proofOk;
  if (proof.type === "signature") {
    proofOk = await verifySignature(listing, proof);
  } else {
    proofOk = await verifyWellKnown(listing);
  }
  if (!proofOk.ok) return json({ error: "ownership proof failed", proof: proofOk }, 400);

  const fee = await verifyFee(env, body.feeTxHash, proof.type === "signature" ? proof.address : null);
  if (!fee.ok) return json({ error: "fee failed", fee }, 400);

  const record = {
    ...listing,
    version: String(listing.version || "1"),
    chainId: 9200,
    rpcUrl: listing.rpcUrl || "https://rpc.mainnet.lightchain.ai",
    nativeCurrency: listing.nativeCurrency || { symbol: "LCAI", decimals: 18 },
    onramp: listing.onramp || "https://bridge.lightchain.ai/",
    status: listing.status || "transactable",
    verified: true,
    tier: "C",
    submittedAt: new Date().toISOString(),
  };

  const submitted = await loadSubmitted(env);
  const next = submitted.filter((a) => a.id !== record.id);
  next.push(record);
  if (env.REGISTRY_KV) {
    await env.REGISTRY_KV.put("submitted", JSON.stringify(next));
    await env.REGISTRY_KV.put("fee:" + body.feeTxHash.toLowerCase(), record.id);
  }
  return json({ ok: true, id: record.id });
}

function howToPay(app) {
  if (!app) return { error: "unknown app" };
  if (app.status === "directory-only" || !app.endpoint) {
    return {
      id: app.id,
      status: "directory-only",
      url: app.url,
      onramp: app.onramp,
      note: "No agent payment rail yet. Open the url in a wallet browser.",
    };
  }
  return {
    id: app.id,
    status: app.status,
    chainId: 9200,
    rpcUrl: app.rpcUrl,
    nativeCurrency: app.nativeCurrency,
    token: "LCAI",
    payment: app.payment,
    endpoint: app.endpoint,
    onramp: app.onramp,
  };
}

const MCP_TOOLS = [
  {
    name: "list_apps",
    description: "List Lightchain apps. Filter by category, payment.kind, owner, status.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string" },
        kind: { type: "string", description: "payment.kind" },
        owner: { type: "string", enum: ["keikodev", "protocol", "community"] },
        status: { type: "string", enum: ["directory-only", "transactable"] },
      },
    },
  },
  {
    name: "get_app",
    description: "Get one app listing by id.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
    },
  },
  {
    name: "how_to_pay",
    description: "Return chain, token, spender, and call data for an app. Not a pre-signed tx.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
    },
  },
  {
    name: "get_onramp",
    description: "Official one-tx ETH → native LCAI on-ramp (Buy & Bridge).",
    inputSchema: { type: "object", properties: {} },
  },
];

function mcpResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function mcpErr(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleMcp(req, env, apps) {
  if (req.method === "GET") {
    return json({
      name: "lightchain-registry",
      version: "1.0.0",
      transport: "json-rpc POST /mcp",
      tools: MCP_TOOLS.map((t) => t.name),
    });
  }
  let body;
  try {
    body = await req.json();
  } catch {
    return json(mcpErr(null, -32700, "parse error"), 400);
  }
  const id = body.id ?? null;
  const method = body.method;
  const params = body.params || {};

  if (method === "initialize") {
    return json(
      mcpResult(id, {
        protocolVersion: "2025-03-26",
        serverInfo: { name: "lightchain-registry", version: "1.0.0" },
        capabilities: { tools: {} },
      })
    );
  }
  if (method === "notifications/initialized" || method === "initialized") {
    return new Response(null, { status: 204 });
  }
  if (method === "ping") return json(mcpResult(id, {}));
  if (method === "tools/list") return json(mcpResult(id, { tools: MCP_TOOLS }));
  if (method === "tools/call") {
    const name = params.name;
    const args = params.arguments || {};
    let payload;
    if (name === "list_apps") payload = filterApps(apps, args);
    else if (name === "get_app") payload = apps.find((a) => a.id === args.id) || { error: "unknown id" };
    else if (name === "how_to_pay") payload = howToPay(apps.find((a) => a.id === args.id));
    else if (name === "get_onramp") {
      payload = {
        name: "Buy & Bridge",
        url: "https://bridge.lightchain.ai/",
        chainId: 9200,
        note: "One user signature. ETH on Ethereum → native LCAI on Lightchain via LcaiZap.",
      };
    } else return json(mcpErr(id, -32601, "unknown tool"));
    return json(
      mcpResult(id, {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      })
    );
  }
  return json(mcpErr(id, -32601, "method not found"));
}

function homePage(origin) {
  const html = `<!doctype html><meta charset="utf-8"><title>Lightchain Agent Registry</title>
<body style="font-family:system-ui;max-width:40rem;margin:3rem auto;padding:0 1rem;line-height:1.5">
<h1>Lightchain Agent Registry</h1>
<p>Directory of apps on Lightchain (chain 9200) for AI agents. Yellow Pages — no ERC-8004 required.</p>
<ul>
<li><a href="/.well-known/lightchain-apps.json">/.well-known/lightchain-apps.json</a></li>
<li>MCP JSON-RPC: POST /mcp — tools list_apps, get_app, how_to_pay, get_onramp</li>
<li>Submit: POST /submit (ownership proof + 1 LCAI fee)</li>
</ul>
<p>On-ramp: <a href="https://bridge.lightchain.ai/">bridge.lightchain.ai</a> (Buy &amp; Bridge)</p>
</body>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "content-type, mcp-session-id",
          "access-control-allow-methods": "GET, POST, OPTIONS",
        },
      });
    }
    const url = new URL(req.url);
    const submitted = await loadSubmitted(env);
    const apps = mergeCatalog(submitted);
    const path = url.pathname.replace(/\/$/, "") || "/";

    if (path === "/" && req.method === "GET") return homePage(url.origin);
    if (path === "/.well-known/lightchain-apps.json" || path === "/apps.json") {
      const q = {
        category: url.searchParams.get("category"),
        kind: url.searchParams.get("kind"),
        owner: url.searchParams.get("owner"),
        status: url.searchParams.get("status"),
      };
      return json(catalogDoc(filterApps(apps, q)));
    }
    if (path === "/mcp") return handleMcp(req, env, apps);
    if (path === "/submit" || path === "/api/submit") return handleSubmit(req, env);
    if (path === "/health") return json({ ok: true, apps: apps.length });
    return json({ error: "not found" }, 404);
  },
};
