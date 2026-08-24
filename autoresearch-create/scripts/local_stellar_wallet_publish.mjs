import http from "node:http";
import { generateNonce, openBrowser } from "./local_solana_wallet_publish.mjs";

const ADDRESS_RE = /^G[A-Z2-7]{55}$/;
const XDR_RE = /^[A-Za-z0-9+/=]+$/;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export async function startLocalStellarWalletPublish({
  network,
  rpcUrl,
  networkPassphrase,
  contractId,
  summary = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  open = true,
  logger = console,
  opener = openBrowser,
} = {}) {
  const token = generateNonce(24);
  let connectedAddress = null;
  let pendingSignRequest = null;
  let resolveAccount;
  const accountReady = new Promise((resolve) => {
    resolveAccount = resolve;
  });
  let resolveSigned;
  let rejectSigned;
  const signedReady = new Promise((resolve, reject) => {
    resolveSigned = resolve;
    rejectSigned = reject;
  });

  const state = {
    summary,
    progress: {
      status: "in-progress",
      currentStepId: "connect",
      steps: [
        { id: "connect", label: "Connect your Stellar wallet", status: "active", detail: "" },
        { id: "sign", label: "Sign create_project transaction", status: "pending", detail: "" },
      ],
    },
    walletStatus: "",
  };

  const server = http.createServer(async (req, res) => {
    try {
      const expectedPrefix = `/${token}`;
      if (
        !req.url?.startsWith(expectedPrefix) ||
        (req.url.length > expectedPrefix.length && req.url[expectedPrefix.length] !== "/")
      ) {
        sendText(res, 404, "not found");
        return;
      }
      if (!originAllowed(req)) {
        sendJson(res, 403, { error: "invalid origin" });
        return;
      }
      const route = req.url.slice(token.length + 1).split("?")[0] || "/";
      if (req.method === "GET" && (route === "/" || route === "/sign")) {
        sendHtml(res, renderSignPage());
        return;
      }
      if (req.method === "GET" && route === "/session") {
        sendJson(res, 200, {
          chain: { network, rpcUrl, networkPassphrase, contractId },
          summary: normalizeJson(state.summary),
          connectedAddress,
        });
        return;
      }
      if (req.method === "GET" && route === "/progress") {
        sendJson(res, 200, {
          progress: normalizeJson(state.progress),
          walletStatus: state.walletStatus,
        });
        return;
      }
      if (req.method === "POST" && route === "/account") {
        const body = await readJsonBody(req);
        const address = requireAddress(body.address, "address");
        connectedAddress = address;
        setStepStatus("connect", "done", address);
        setStepStatus("sign", pendingSignRequest ? "active" : "pending");
        resolveAccount(address);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === "GET" && route === "/sign-request") {
        sendJson(res, 200, {
          request: pendingSignRequest
            ? {
                id: pendingSignRequest.id,
                xdr: pendingSignRequest.xdr,
                address: connectedAddress,
                networkPassphrase,
                submitUrl: rpcUrl,
              }
            : null,
        });
        return;
      }
      if (req.method === "POST" && route === "/signed") {
        const body = await readJsonBody(req);
        const address = requireAddress(body.address, "address");
        if (connectedAddress !== address) {
          sendJson(res, 400, { error: "signed transaction address did not match connected wallet" });
          return;
        }
        if (!pendingSignRequest || body.id !== pendingSignRequest.id) {
          sendJson(res, 400, { error: "no matching sign request is pending" });
          return;
        }
        const signedTxXdr = requireXdr(body.signedTxXdr, "signedTxXdr");
        setStepStatus("sign", "done", "Signed transaction received by CLI.");
        state.progress.status = "complete";
        resolveSigned({ address, signedTxXdr });
        pendingSignRequest = null;
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === "POST" && route === "/error") {
        const body = await readJsonBody(req);
        const message = String(body.message || "wallet reported an error");
        state.walletStatus = message;
        setStepStatus(state.progress.currentStepId || "sign", "error", message);
        rejectSigned(new Error(message));
        sendJson(res, 200, { ok: true });
        return;
      }
      sendText(res, 404, "not found");
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
  });

  const timeout = setTimeout(() => {
    rejectSigned(new Error("timed out waiting for browser wallet approval"));
    server.close();
  }, timeoutMs);
  timeout.unref?.();
  signedReady.finally(() => clearTimeout(timeout)).catch(() => {});

  await listen(server);
  const url = `${localOrigin(server)}/${token}/sign`;
  if (open) {
    try {
      opener(url);
    } catch (err) {
      logger.warn?.(`Could not open browser automatically: ${err.message}`);
    }
  }

  return {
    url,
    result: signedReady,
    waitForAccount() {
      return connectedAddress ? Promise.resolve(connectedAddress) : accountReady;
    },
    setSummary(nextSummary) {
      state.summary = nextSummary;
    },
    async signTransaction(xdr, opts = {}) {
      const requestedAddress = opts.address ? requireAddress(opts.address, "signing address") : connectedAddress;
      if (!requestedAddress) throw new Error("browser wallet is not connected");
      if (connectedAddress !== requestedAddress) {
        throw new Error(`connected wallet ${connectedAddress} does not match requested signer ${requestedAddress}`);
      }
      pendingSignRequest = {
        id: generateNonce(12),
        xdr: requireXdr(xdr, "transaction xdr"),
      };
      setStepStatus("sign", "active", "Approve the Stellar transaction in your browser wallet.");
      const signed = await signedReady;
      return { signedTxXdr: signed.signedTxXdr, signerAddress: signed.address };
    },
    setComplete(payload = {}) {
      for (const step of state.progress.steps) {
        if (step.status !== "error") step.status = "done";
      }
      state.progress.status = "complete";
      state.progress.completion = normalizeJson(payload);
      state.walletStatus = "";
    },
    close({ delayMs = 0 } = {}) {
      clearTimeout(timeout);
      const closeNow = () => {
        try {
          server.close();
        } catch {
          // already closed
        }
      };
      if (delayMs > 0) {
        return new Promise((resolve) => {
          const t = setTimeout(() => {
            closeNow();
            resolve();
          }, delayMs);
          t.unref?.();
        });
      }
      closeNow();
      return Promise.resolve();
    },
  };

  function setStepStatus(stepId, status, detail = "") {
    const step = state.progress.steps.find((item) => item.id === stepId);
    if (step) {
      step.status = status;
      if (detail !== undefined) step.detail = String(detail || "");
    }
    if (status === "active") state.progress.currentStepId = stepId;
  }
}

function renderSignPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OpenResearch Stellar Publish</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 2rem; max-width: 880px; }
    button { font: inherit; padding: 0.7rem 1rem; border-radius: 8px; border: 1px solid #777; cursor: pointer; }
    pre { background: #111; color: #eee; padding: 1rem; overflow: auto; border-radius: 8px; }
    .muted { color: #666; }
    .error { color: #b00020; }
    .ok { color: #05620f; }
  </style>
</head>
<body>
  <h1>OpenResearch Stellar Publish</h1>
  <p>This local page lets your Stellar wallet sign the project publish transaction. The CLI keeps running locally and receives only the signed transaction XDR.</p>
  <p><button id="connect">Connect Stellar Wallet</button> <button id="sign" disabled>Sign Pending Transaction</button></p>
  <p id="status" class="muted">Waiting for wallet connection.</p>
  <h2>Session</h2>
  <pre id="session">{}</pre>
  <script type="module">
    const base = location.pathname.replace(/\\/(sign)?$/, "");
    const statusEl = document.getElementById("status");
    const sessionEl = document.getElementById("session");
    const connectButton = document.getElementById("connect");
    const signButton = document.getElementById("sign");
    let session = null;
    let address = null;

    function setStatus(message, className = "muted") {
      statusEl.className = className;
      statusEl.textContent = message;
    }
    async function postJson(route, body) {
      const res = await fetch(base + route, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || res.statusText);
      return payload;
    }
    async function getJson(route) {
      const res = await fetch(base + route);
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || res.statusText);
      return payload;
    }
    async function loadFreighter() {
      if (window.freighterApi) return window.freighterApi;
      try {
        return await import("https://esm.sh/@stellar/freighter-api?bundle");
      } catch {
        throw new Error("Could not load Freighter API. Install Freighter or another SEP-43 compatible Stellar wallet.");
      }
    }
    function unwrapAddress(value) {
      if (typeof value === "string") return value;
      return value?.address || value?.publicKey || value?.result?.address || value?.result?.publicKey;
    }
    async function requestWalletAddress(api) {
      if (api.requestAccess) return unwrapAddress(await api.requestAccess());
      if (api.getAddress) return unwrapAddress(await api.getAddress());
      throw new Error("Wallet API does not expose requestAccess or getAddress.");
    }
    async function signWithWallet(api, request) {
      const response = await api.signTransaction(request.xdr, {
        networkPassphrase: request.networkPassphrase,
        address: request.address,
        submit: false,
        submitUrl: request.submitUrl,
      });
      if (typeof response === "string") return response;
      return response?.signedTxXdr || response?.signedXDR || response?.result?.signedTxXdr;
    }
    async function refresh() {
      session = await getJson("/session");
      sessionEl.textContent = JSON.stringify(session, null, 2);
      const { request } = await getJson("/sign-request");
      signButton.disabled = !address || !request;
      if (request && address) setStatus("Transaction is ready. Review and sign in your wallet.");
      return request;
    }
    connectButton.addEventListener("click", async () => {
      try {
        const api = await loadFreighter();
        address = await requestWalletAddress(api);
        if (!address) throw new Error("Wallet did not return an address.");
        await postJson("/account", { address });
        setStatus("Connected " + address, "ok");
        await refresh();
      } catch (err) {
        setStatus(err.message, "error");
        await postJson("/error", { message: err.message }).catch(() => {});
      }
    });
    signButton.addEventListener("click", async () => {
      try {
        const request = await refresh();
        if (!request) throw new Error("No transaction is pending yet.");
        const api = await loadFreighter();
        const signedTxXdr = await signWithWallet(api, request);
        if (!signedTxXdr) throw new Error("Wallet did not return signed transaction XDR.");
        await postJson("/signed", { id: request.id, address, signedTxXdr });
        setStatus("Signed transaction returned to CLI.", "ok");
        signButton.disabled = true;
      } catch (err) {
        setStatus(err.message, "error");
        await postJson("/error", { message: err.message }).catch(() => {});
      }
    });
    setInterval(() => refresh().catch(() => {}), 1500);
    refresh().catch((err) => setStatus(err.message, "error"));
  </script>
</body>
</html>`;
}

function requireAddress(value, label) {
  const text = String(value || "").trim();
  if (!ADDRESS_RE.test(text)) throw new Error(`${label} must be a Stellar G... address`);
  return text;
}

function requireXdr(value, label) {
  const text = String(value || "").trim();
  if (!text || !XDR_RE.test(text)) throw new Error(`${label} must be base64 XDR`);
  return text;
}

function normalizeJson(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(
    JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item)),
  );
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

function sendHtml(res, html) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  } catch {
    return false;
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function localOrigin(server) {
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}
