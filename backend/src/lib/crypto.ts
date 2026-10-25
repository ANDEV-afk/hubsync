import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { Buffer } from "node:buffer";
import { AppError } from "./errors.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getEncryptionKey(): Buffer {
  const encodedKey = process.env.TOKEN_ENCRYPTION_KEY?.trim();

  if (!encodedKey) {
    throw new AppError(
      500,
      "Required environment variable TOKEN_ENCRYPTION_KEY is missing",
      "CONFIGURATION_ERROR",
    );
  }

  if (/^[0-9a-fA-F]{64}$/.test(encodedKey)) {
    return Buffer.from(encodedKey, "hex");
  }

  try {
    const key = Buffer.from(encodedKey, "base64");
    if (key.length === 32) {
      return key;
    }
  } catch {
    // Fall through to the safe configuration error below.
  }

  throw new AppError(
    500,
    "TOKEN_ENCRYPTION_KEY must be a 32-byte base64 value or a 64-character hex value",
    "CONFIGURATION_ERROR",
  );
}

export function encryptToken(token: string): string {
  if (!token) {
    throw new AppError(500, "Cannot encrypt an empty token", "TOKEN_ERROR");
  }

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    "v1",
    iv.toString("base64url"),
    authTag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptToken(encryptedToken: string): string {
  try {
    const [version, ivEncoded, authTagEncoded, ciphertextEncoded] =
      encryptedToken.split(".");

    if (
      version !== "v1" ||
      !ivEncoded ||
      !authTagEncoded ||
      !ciphertextEncoded
    ) {
      throw new Error("Invalid encrypted token format");
    }

    const iv = Buffer.from(ivEncoded, "base64url");
    const authTag = Buffer.from(authTagEncoded, "base64url");
    const ciphertext = Buffer.from(ciphertextEncoded, "base64url");

    if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
      throw new Error("Invalid encrypted token metadata");
    }

    const decipher = createDecipheriv(ALGORITHM, getEncryptionKey(), iv);
    decipher.setAuthTag(authTag);

    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new AppError(
      500,
      "Stored HubSpot token could not be decrypted",
      "TOKEN_DECRYPTION_FAILED",
    );
  }
}
