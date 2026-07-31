import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

/**
 * §16.1: "Detached digital signature over a canonical JSON of the receipt
 * fields; publish the verification key." §16.2's offline verification needs
 * an asymmetric scheme (Ed25519) so a third party can verify with no network
 * access, given only the payload + signature + published public key — an
 * HMAC (shared-secret) scheme wouldn't satisfy "publish the verification
 * key" since publishing an HMAC secret would let anyone forge receipts.
 *
 * The keypair below is a FIXED DEMO keypair, generated once and checked in —
 * explicitly a demo artifact (this is a recordable demo build, not a
 * production deployment), never a real signing key. A production build
 * would load this from a real KMS/HSM (§19/§20, explicitly out of scope
 * here per CLAUDE.md's own "things that will tempt you" table).
 */

// PKCS#8 / SPKI PEM for a fixed Ed25519 demo keypair (a real generated
// keypair, checked in for this demo build only — see the module doc above).
const DEMO_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIMrOLOlWgxEB0LffhYXwtCi2peM+GmQqNLTJqwHjrEPi
-----END PRIVATE KEY-----`;

const DEMO_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA1VmUONIj/TRKNFSvCXuJ4eOI+KKol00P5vako8C3Xj4=
-----END PUBLIC KEY-----`;

function canonicalJson(value: unknown): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  return JSON.stringify(sortKeys(value));
}

export function getPublicKeyPem(): string {
  return DEMO_PUBLIC_KEY_PEM;
}

export interface SignedReceipt {
  canonicalPayload: string;
  signatureBase64: string;
  publicKeyPem: string;
}

/** Signs the canonical JSON of the receipt fields — a detached signature,
 * per §16.1: the payload travels alongside the signature, not embedded in it. */
export function signReceiptPayload(payload: Record<string, unknown>): SignedReceipt {
  const canonicalPayload = canonicalJson(payload);
  const privateKey = createPrivateKey({ key: DEMO_PRIVATE_KEY_PEM, format: "pem" });
  const signature = sign(null, Buffer.from(canonicalPayload, "utf8"), privateKey);
  return { canonicalPayload, signatureBase64: signature.toString("base64"), publicKeyPem: DEMO_PUBLIC_KEY_PEM };
}

/** §16.2's offline verification: given only the payload, signature, and
 * public key (no DB, no network), this returns true/false deterministically —
 * exactly what a rural licensing office with no connectivity needs. */
export function verifyReceiptSignature(canonicalPayload: string, signatureBase64: string, publicKeyPem: string = DEMO_PUBLIC_KEY_PEM): boolean {
  try {
    const publicKey = createPublicKey({ key: publicKeyPem, format: "pem" });
    return verify(null, Buffer.from(canonicalPayload, "utf8"), publicKey, Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}
