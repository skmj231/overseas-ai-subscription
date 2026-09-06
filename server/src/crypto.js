/* 빌링키 암호화(AES-256-GCM)와 관리 링크 토큰(HMAC). */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

function keyFrom(hex, name) {
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${name}는 64자리 hex(32바이트)여야 합니다. openssl rand -hex 32`);
  return Buffer.from(hex, "hex");
}

export function makeCrypto({ BILLING_KEY_SECRET, LICENSE_TOKEN_SECRET }) {
  const k = keyFrom(BILLING_KEY_SECRET, "BILLING_KEY_SECRET");
  const t = keyFrom(LICENSE_TOKEN_SECRET, "LICENSE_TOKEN_SECRET");

  function encrypt(plain) {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", k, iv);
    const enc = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
    return ["v1", iv.toString("base64url"), enc.toString("base64url"), c.getAuthTag().toString("base64url")].join(".");
  }
  function decrypt(blob) {
    const [v, iv, enc, tag] = String(blob).split(".");
    if (v !== "v1") throw new Error("unknown blob version");
    const d = createDecipheriv("aes-256-gcm", k, Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(enc, "base64url")), d.final()]).toString("utf8");
  }

  /* token = base64url(json).sig — 관리 페이지·메일 링크용. 기본 24시간. */
  function sign(payload, ttlMs = 24 * 3600000) {
    const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs })).toString("base64url");
    const sig = createHmac("sha256", t).update(body).digest("base64url");
    return `${body}.${sig}`;
  }
  function verify(token) {
    if (typeof token !== "string" || !token.includes(".")) return null;
    const [body, sig] = token.split(".");
    const expect = createHmac("sha256", t).update(body).digest("base64url");
    if (sig.length !== expect.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    try {
      const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      if (!p.exp || p.exp < Date.now()) return null;
      return p;
    } catch { return null; }
  }
  return { encrypt, decrypt, sign, verify };
}
