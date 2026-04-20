import { pbkdf2, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const pbkdf2Async = promisify(pbkdf2);
const ITERATIONS = 100_000;
const KEY_LEN = 64;
const DIGEST = "sha512";

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const hash = await pbkdf2Async(password, salt, ITERATIONS, KEY_LEN, DIGEST);
  return `${salt}:${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const derived = await pbkdf2Async(password, salt, ITERATIONS, KEY_LEN, DIGEST);
  const derivedBuf = Buffer.from(derived.toString("hex"));
  const hashBuf = Buffer.from(hash);
  if (derivedBuf.length !== hashBuf.length) return false;
  return timingSafeEqual(derivedBuf, hashBuf);
}
