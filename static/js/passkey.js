"use strict";
/* ---------------- パスキー(指紋・顔・PIN・セキュリティキーでログイン) ---------------- */
/* ブラウザの決まりで、HTTPS か localhost の名前で開いたときだけ使える(IP アドレスでは使えない) */
const pkB64 = {
  dec: (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0)).buffer,
  enc: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
};
const passkeySupported = () => !!window.PublicKeyCredential && window.isSecureContext && !/^[\d.]+$|:/.test(location.hostname);
function pkCredToJSON(c) {
  const r = c.response, out = { id: c.id, rawId: pkB64.enc(c.rawId), type: c.type, response: { clientDataJSON: pkB64.enc(r.clientDataJSON) } };
  if (r.attestationObject) { out.response.attestationObject = pkB64.enc(r.attestationObject); out.response.transports = r.getTransports ? r.getTransports() : []; }
  if (r.authenticatorData) {
    out.response.authenticatorData = pkB64.enc(r.authenticatorData);
    out.response.signature = pkB64.enc(r.signature);
    out.response.userHandle = r.userHandle ? pkB64.enc(r.userHandle) : null;
  }
  return out;
}
const pkErr = (e) => e && e.name === "NotAllowedError" ? "取り消されたか、時間切れになりました" : e && e.name === "InvalidStateError" ? "この端末のパスキーはすでに登録されています" : (e && e.message) || "パスキーを使えませんでした";

async function passkeyLogin() {
  const o = await api("/api/auth/passkey/options", { method: "POST" });
  let cred;
  try {
    cred = await navigator.credentials.get({ publicKey: { ...o, challenge: pkB64.dec(o.challenge), allowCredentials: (o.allowCredentials || []).map((x) => ({ ...x, id: pkB64.dec(x.id) })) } });
  } catch (e) { throw new Error(pkErr(e)); }
  return api("/api/auth/passkey", { json: { credential: pkCredToJSON(cred) } });
}

async function passkeyRegister(name) {
  const o = await api("/api/me/passkeys/options", { method: "POST" });
  let cred;
  try {
    cred = await navigator.credentials.create({ publicKey: { ...o, challenge: pkB64.dec(o.challenge), user: { ...o.user, id: pkB64.dec(o.user.id) },
      excludeCredentials: (o.excludeCredentials || []).map((x) => ({ ...x, id: pkB64.dec(x.id) })) } });
  } catch (e) { throw new Error(pkErr(e)); }
  return api("/api/me/passkeys", { json: { credential: pkCredToJSON(cred), name } });
}

/* 端末の名前の見当(登録するときの名前の初めの値) */
function pkGuessName() {
  const ua = navigator.userAgent;
  return /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) ? "iPad"
    : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "この端末";
}
