import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export function encryptToken(token: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

export function decryptToken(value: string, key: Buffer): string {
  const [encodedIv, encodedTag, encodedEncrypted, ...extra] = value.split(".");
  if (!encodedIv || !encodedTag || !encodedEncrypted || extra.length > 0) {
    throw new Error("Stored Google token has an invalid format.");
  }

  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(encodedIv, "base64url"));
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encodedEncrypted, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
