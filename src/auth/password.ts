import { randomBytes } from "node:crypto";
import { argon2id, argon2Verify } from "hash-wasm";

// argon2id, OWASP-minimum profile (19 MiB, 2 passes, 1 lane). WASM: no native build needed.
const PARAMS = { parallelism: 1, iterations: 2, memorySize: 19456, hashLength: 32 };

export async function hashPassword(password: string): Promise<string> {
  return argon2id({ password, salt: randomBytes(16), ...PARAMS, outputType: "encoded" });
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  try {
    return await argon2Verify({ password, hash: encoded });
  } catch {
    return false;
  }
}

// Unknown-email logins still spend one hash verification, so response time doesn't reveal account existence.
let dummyHash: Promise<string> | null = null;
export async function burnVerify(password: string): Promise<void> {
  dummyHash ??= hashPassword("not-a-real-password");
  await verifyPassword(password, await dummyHash);
}
