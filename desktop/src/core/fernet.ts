/**
 * Fernet 兼容实现（AES-128-CBC + HMAC-SHA256）。
 *
 * Python 版用 cryptography.fernet 加密 accounts.cookie_enc 与备份文件。
 * 迁移到 Node 后必须能读同一份密文，所以这里按多语言规范逐字节实现，
 * 密钥仍然复用 `%LOCALAPPDATA%\EchoQ-Ops\secret.key`，不做任何格式转换。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { KEY_PATH } from "./config";

let cachedKey: Buffer | null = null;

export function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  if (!fs.existsSync(KEY_PATH)) {
    throw new Error(`未找到 Cookie 加密密钥：${KEY_PATH}，请先用原版登录一次账号`);
  }
  const text = fs.readFileSync(KEY_PATH, "utf8").replace(/\s+/g, "");
  const key = Buffer.from(text.replace(/=+$/, ""), "base64url");
  if (key.length !== 32) throw new Error("Cookie 加密密钥格式不正确（应为 32 字节 Fernet Key）");
  cachedKey = key;
  return key;
}

function sign(key: Buffer, data: Buffer): Buffer {
  // Fernet 规范：前 16 字节用于 HMAC 签名，后 16 字节用于 AES 加密。
  return crypto.createHmac("sha256", key.subarray(0, 16)).update(data).digest();
}

export function encrypt(text: string): string {
  return encryptBytes(Buffer.from(text, "utf8"));
}

/** 与 Python 的 security.encrypt_bytes 一致：对原始字节做 Fernet。 */
export function encryptBytes(data: Buffer): string {
  const key = loadKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-128-cbc", key.subarray(16, 32), iv);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  const time = Buffer.alloc(8);
  time.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)));
  const body = Buffer.concat([Buffer.from([0x80]), time, iv, ciphertext]);
  // Python 的 base64.urlsafe_b64decode 要求补足 '='，这里显式补齐。
  const encoded = Buffer.concat([body, sign(key, body)]).toString("base64url");
  return encoded + "=".repeat((4 - (encoded.length % 4)) % 4);
}

export function decrypt(token: string): string {
  return decryptBytes(Buffer.from(token, "ascii")).toString("utf8");
}

/** 与 Python 的 security.decrypt_bytes 一致：返回解密后的原始字节。 */
export function decryptBytes(token: Buffer | string): Buffer {
  const key = loadKey();
  const raw = Buffer.from(String(token).replace(/=+$/, ""), "base64url");
  if (raw.length < 73) throw new Error("Cookie 密文过短，无法解密");
  const body = raw.subarray(0, raw.length - 32);
  const mac = raw.subarray(raw.length - 32);
  const expected = sign(key, body);
  if (mac.length !== expected.length || !crypto.timingSafeEqual(mac, expected)) {
    throw new Error("解密失败：密钥与密文不匹配（请确认 secret.key 未更换）");
  }
  if (body[0] !== 0x80) throw new Error("不支持的密文版本");
  const iv = body.subarray(9, 25);
  const ciphertext = body.subarray(25);
  const decipher = crypto.createDecipheriv("aes-128-cbc", key.subarray(16, 32), iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
