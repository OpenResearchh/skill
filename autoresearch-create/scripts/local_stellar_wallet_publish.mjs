import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export function generateNonce(bytes = 16) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return url.hostname === "127.0.0.1" || url.hostname === "localhost";
  } catch {
    return false;
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

function sendHtml(res, html) {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(html);
}

function sendText(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function openBrowser(url) {
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(opener, args, { stdio: "ignore", detached: true }).unref();
}

const WALLET_PAGE_RUNTIME = String.raw`
const statusEl = document.getElementById("status");
const signBtn = document.getElementById("sign");
const walletEl = document.getElementById("wallet");
let publicKey = null;
let selectedWallet = "freighter";

function setStatus(text, ok) {
  statusEl.textContent = text;
  statusEl.className = ok === true ? "ok" : ok === false ? "err" : "";
}

function networkHints(passphrase) {
  var isPublic = String(passphrase).indexOf("Public Global Stellar Network") !== -1;
  return {
    rabet: isPublic ? "mainnet" : "testnet",
    albedo: isPublic ? "public" : "testnet",
    xbull: isPublic ? "PUBLIC" : "TESTNET"
  };
}

function unwrapAddress(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  return value.address || value.publicKey || value.pubkey || null;
}

function unwrapSignedXdr(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  return value.signedTxXdr || value.signed_envelope_xdr || value.xdr || value.signedXdr || null;
}

function freighter() {
  return window.freighterApi || (window.stellar && window.stellar.freighterApi) || null;
}

function detectWallets() {
  var list = [];
  if (freighter()) list.push({ id: "freighter", label: "Freighter" });
  if (window.rabet) list.push({ id: "rabet", label: "Rabet" });
  if (window.xBullSDK) list.push({ id: "xbull", label: "xBull" });
  list.push({ id: "albedo", label: "Albedo (web, no extension)" });
  return list;
}

function refreshWalletOptions() {
  var wallets = detectWallets();
  var previous = walletEl.value || selectedWallet;
  var html = "";
  for (var i = 0; i < wallets.length; i += 1) {
    html += "<option value=\"" + wallets[i].id + "\">" + wallets[i].label + "</option>";
  }
  walletEl.innerHTML = html;
  var ids = wallets.map(function (w) { return w.id; });
  walletEl.value = ids.indexOf(previous) >= 0 ? previous : wallets[0].id;
  selectedWallet = walletEl.value;
}

function albedoIntent(params) {
  return new Promise(function (resolve, reject) {
    var query = new URLSearchParams(params);
    var popup = window.open("https://albedo.link/intent?" + query.toString(), "albedo", "width=480,height=720");
    if (!popup) {
      reject(new Error("Albedo popup was blocked. Allow popups for this page and try again."));
      return;
    }
    var done = false;
    function finish(err, data) {
      if (done) return;
      done = true;
      window.removeEventListener("message", onMessage);
      window.clearInterval(timer);
      if (err) reject(err);
      else resolve(data);
    }
    function onMessage(ev) {
      if (ev.origin !== "https://albedo.link" && ev.origin !== "https://albedo.stellar.org") return;
      var data = ev.data || {};
      if (data.error || data.errorMessage) {
        finish(new Error(data.errorMessage || data.error || "Albedo rejected the request"));
        return;
      }
      if (data.pubkey || data.signed_envelope_xdr || data.xdr) finish(null, data);
    }
    window.addEventListener("message", onMessage);
    var timer = window.setInterval(function () {
      if (popup.closed) finish(new Error("Albedo window closed before signing"));
    }, 400);
  });
}

async function connectFreighter() {
  var api = freighter();
  if (!api) throw new Error("Freighter is not installed. Install it, reload this page, and connect again.");
  if (api.requestAccess) await api.requestAccess();
  return unwrapAddress(await (api.getPublicKey ? api.getPublicKey() : api.getAddress()));
}

async function connectRabet() {
  if (!window.rabet) throw new Error("Rabet is not installed. Install it, reload this page, and connect again.");
  return unwrapAddress(await window.rabet.connect());
}

async function connectXbull() {
  if (!window.xBullSDK) throw new Error("xBull is not installed. Install it, reload this page, and connect again.");
  if (window.xBullSDK.connect) {
    await window.xBullSDK.connect({ canRequestPublicKey: true, canRequestSign: true });
  }
  if (window.xBullSDK.getPublicKey) return unwrapAddress(await window.xBullSDK.getPublicKey());
  throw new Error("xBull did not expose getPublicKey");
}

async function connectAlbedo() {
  var result = await albedoIntent({ intent: "public_key", callback: "postMessage" });
  return unwrapAddress(result);
}

async function signFreighter(xdr, passphrase) {
  var api = freighter();
  if (!api || !api.signTransaction) throw new Error("Freighter is not available to sign");
  return unwrapSignedXdr(await api.signTransaction(xdr, {
    networkPassphrase: passphrase,
    address: publicKey
  }));
}

async function signRabet(xdr, hints) {
  if (!window.rabet) throw new Error("Rabet is not available to sign");
  return unwrapSignedXdr(await window.rabet.sign(xdr, hints.rabet));
}

async function signXbull(xdr, passphrase, hints) {
  if (!window.xBullSDK) throw new Error("xBull is not available to sign");
  var sdk = window.xBullSDK;
  var attempts = [
    { xdr: xdr, publicKey: publicKey, network: passphrase },
    { xdr: xdr, publicKey: publicKey, network: hints.xbull }
  ];
  var lastErr = null;
  for (var i = 0; i < attempts.length; i += 1) {
    try {
      if (sdk.signXDR) return unwrapSignedXdr(await sdk.signXDR(attempts[i]));
      if (sdk.sign) return unwrapSignedXdr(await sdk.sign(attempts[i]));
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("xBull did not expose signXDR");
}

async function signAlbedo(xdr, hints) {
  var result = await albedoIntent({
    intent: "tx",
    xdr: xdr,
    network: hints.albedo,
    pubkey: publicKey,
    callback: "postMessage",
    submit: "false"
  });
  return unwrapSignedXdr(result);
}

async function connect() {
  selectedWallet = walletEl.value;
  var connectors = {
    freighter: connectFreighter,
    rabet: connectRabet,
    xbull: connectXbull,
    albedo: connectAlbedo
  };
  var connector = connectors[selectedWallet];
  if (!connector) throw new Error("Select a Stellar wallet first");
  publicKey = await connector();
  if (!publicKey) throw new Error("wallet did not return a public key");
  var res = await fetch("account", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ publicKey: publicKey, wallet: selectedWallet })
  });
  var body = await res.json();
  if (!res.ok) throw new Error(body.error || "account rejected");
  signBtn.disabled = false;
  setStatus("Connected as " + publicKey + " via " + selectedWallet, true);
}

async function signAndSubmit() {
  var unsigned;
  for (var i = 0; i < 60; i += 1) {
    var res = await fetch("tx");
    unsigned = await res.json();
    if (unsigned.xdr) break;
    await new Promise(function (r) { setTimeout(r, 500); });
  }
  if (!unsigned || !unsigned.xdr) throw new Error((unsigned && unsigned.error) || "transaction was not ready to sign");
  var passphrase = unsigned.networkPassphrase || networkPassphrase;
  var hints = networkHints(passphrase);
  var signers = {
    freighter: function () { return signFreighter(unsigned.xdr, passphrase); },
    rabet: function () { return signRabet(unsigned.xdr, hints); },
    xbull: function () { return signXbull(unsigned.xdr, passphrase, hints); },
    albedo: function () { return signAlbedo(unsigned.xdr, hints); }
  };
  var signer = signers[selectedWallet];
  if (!signer) throw new Error("Connect a Stellar wallet before signing");
  var signedTxXdr = await signer();
  if (!signedTxXdr) throw new Error("wallet did not return a signed transaction");
  var submit = await fetch("signed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ signedTxXdr: signedTxXdr, publicKey: publicKey, wallet: selectedWallet })
  });
  var body = await submit.json();
  if (!submit.ok) throw new Error(body.error || "submit failed");
  setStatus("Submitted. You can close this tab. " + (body.hash || ""), true);
}

refreshWalletOptions();
window.setInterval(refreshWalletOptions, 1500);
walletEl.addEventListener("change", function () {
  selectedWallet = walletEl.value;
  publicKey = null;
  signBtn.disabled = true;
});
document.getElementById("connect").addEventListener("click", function () {
  connect().catch(function (err) { setStatus(err.message, false); });
});
document.getElementById("sign").addEventListener("click", function () {
  signAndSubmit().catch(function (err) { setStatus(err.message, false); });
});
`;

export function renderSignPage({ networkPassphrase, summary }) {
  const summaryJson = JSON.stringify(summary || {}, null, 2)
    .replace(/</g, "\\u003c")
    .replace(/-->/g, "--\\>");
  const runtime =
    "const summary = " +
    JSON.stringify(summary || {}) +
    ";\nconst networkPassphrase = " +
    JSON.stringify(networkPassphrase) +
    ";\n" +
    WALLET_PAGE_RUNTIME;
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>OpenResearch Stellar publish</title>
<style>
  body { font: 15px/1.45 system-ui, sans-serif; margin: 2rem; max-width: 44rem; color: #111; }
  button, select { font: inherit; padding: .5rem .9rem; cursor: pointer; }
  label { display: block; margin: 1rem 0 .4rem; }
  pre { background: #f4f4f5; padding: 1rem; overflow: auto; }
  .err { color: #b91c1c; }
  .ok { color: #166534; }
</style>
<h1>Publish to Stellar OpenResearch</h1>
<p>Connect a Stellar wallet, review the project, and approve <code>create_project</code>. This page never asks for a secret key. Freighter, Rabet, and xBull are detected if their extensions are installed; Albedo signs in the browser with no extension.</p>
<pre id="summary">${summaryJson}</pre>
<label for="wallet">Wallet</label>
<p><select id="wallet"></select></p>
<p><button id="connect">Connect wallet</button>
<button id="sign" disabled>Sign and submit</button></p>
<p id="status"></p>
<script>${runtime}</script>
</html>`;
}

export async function startLocalStellarWalletPublish({
  networkPassphrase,
  summary = null,
  buildAndSend,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  open = true,
  logger = console,
  opener = openBrowser,
} = {}) {
  if (typeof buildAndSend !== "function") {
    throw new Error("buildAndSend(publicKey, signTransaction) is required");
  }

  const token = generateNonce(24);
  let publicKey = null;
  let unsignedXdr = null;
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
  let settled = false;

  const server = http.createServer(async (req, res) => {
    try {
      const expectedPrefix = `/${token}`;
      if (!req.url?.startsWith(expectedPrefix)) {
        sendText(res, 404, "not found");
        return;
      }
      if (!originAllowed(req)) {
        sendJson(res, 403, { error: "invalid origin" });
        return;
      }
      const route = req.url.slice(token.length + 1).split("?")[0] || "/";
      if (req.method === "GET" && (route === "/" || route === "/sign")) {
        sendHtml(res, renderSignPage({ networkPassphrase, summary }));
        return;
      }
      if (req.method === "POST" && route === "/account") {
        const body = await readBody(req);
        if (!body.publicKey) {
          sendJson(res, 400, { error: "publicKey required" });
          return;
        }
        publicKey = body.publicKey;
        resolveAccount(publicKey);
        sendJson(res, 200, { ok: true, publicKey });
        return;
      }
      if (req.method === "GET" && route === "/tx") {
        if (!unsignedXdr) {
          sendJson(res, 409, { error: "transaction is not ready yet; wait a moment and retry" });
          return;
        }
        sendJson(res, 200, { xdr: unsignedXdr, networkPassphrase });
        return;
      }
      if (req.method === "POST" && route === "/signed") {
        const body = await readBody(req);
        if (!body.signedTxXdr) {
          sendJson(res, 400, { error: "signedTxXdr required" });
          return;
        }
        resolveSigned(body.signedTxXdr);
        sendJson(res, 200, { ok: true, hash: "pending" });
        return;
      }
      sendText(res, 404, "not found");
    } catch (err) {
      sendJson(res, 500, { error: err.message || String(err) });
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/${token}/sign`;
  logger.error(`Open this page to connect a Stellar wallet and sign: ${url}`);
  if (open) opener(url);

  const timeout = setTimeout(() => {
    if (!settled) {
      rejectSigned(new Error("timed out waiting for wallet signature"));
      resolveAccount(null);
    }
  }, timeoutMs);

  try {
    const connected = await accountReady;
    if (!connected) throw new Error("wallet did not connect");

    const signTransaction = async (xdr) => {
      unsignedXdr = xdr;
      return signedReady;
    };

    const result = await buildAndSend(connected, signTransaction);
    settled = true;
    return { ...result, publicKey: connected, url };
  } finally {
    settled = true;
    clearTimeout(timeout);
    await new Promise((resolve) => server.close(resolve));
  }
}
