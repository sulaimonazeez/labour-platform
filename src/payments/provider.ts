import { createHmac, timingSafeEqual } from "node:crypto";

// Provider-agnostic payment interface (PRD §47-49). Adapters talk to a gateway and NEVER touch the database:
// all state changes happen in src/payments/service.ts, inside our own transactions.

export type InitializeInput = {
  reference: string;
  amountMinor: number;
  currency: string;
  email: string;
  callbackUrl?: string;
  metadata?: Record<string, string>;
};
export type InitializeResult = { providerReference: string; checkoutUrl: string };

export type ProviderStatus = "success" | "failed" | "pending";
export type VerifyResult =
  | { found: false }
  | { found: true; status: ProviderStatus; amountMinor: number; currency: string; channel: string | null };

export type WebhookEvent = { type: string; reference: string | null };

// ---- payouts (money OUT). Optional: an adapter without it simply cannot pay providers. ----
export type Bank = { name: string; code: string };
export type TransferInitResult = { status: "processing" | "paid" | "failed" | "otp_required"; providerReference: string };
export type TransferVerify =
  | { found: false }
  | { found: true; status: "processing" | "paid" | "failed"; amountMinor: number; currency: string };
export interface PayoutGateway {
  listBanks(currency: string): Promise<Bank[]>;
  resolveAccount(input: { accountNumber: string; bankCode: string }): Promise<{ accountName: string }>;
  createRecipient(input: { name: string; accountNumber: string; bankCode: string; currency: string }): Promise<{ recipientCode: string }>;
  initiateTransfer(input: { reference: string; amountMinor: number; currency: string; recipientCode: string; reason: string }): Promise<TransferInitResult>;
  verifyTransfer(reference: string): Promise<TransferVerify>;
}

/** One gateway transaction, as listed by the gateway (used by reconciliation only). */
export type ProviderTransaction = { reference: string; status: ProviderStatus; amountMinor: number; currency: string };

export class ProviderError extends Error {
  httpStatus?: number;
  constructor(message: string, httpStatus?: number) {
    super(message);
    this.name = "ProviderError";
    this.httpStatus = httpStatus;
  }
}

export interface PaymentProvider {
  readonly code: string;
  initialize(input: InitializeInput): Promise<InitializeResult>;
  verify(reference: string): Promise<VerifyResult>;
  verifyWebhookSignature(rawBody: string, signature: string | undefined): boolean;
  parseWebhook(rawBody: string): WebhookEvent | null;
  payouts?: PayoutGateway;
  listTransactions?(input: { from: Date; to: Date }): Promise<ProviderTransaction[]>;
}

/** Hex HMAC-SHA512 of the RAW body, compared in constant time (Paystack's x-paystack-signature scheme). */
export function hmacSha512Matches(secret: string, rawBody: string, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = Buffer.from(createHmac("sha512", secret).update(rawBody).digest("hex"), "utf8");
  const given = Buffer.from(signature.trim().toLowerCase(), "utf8");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Parses `{ event, data: { reference } }`, the envelope Paystack uses. Returns null when it is not that shape. */
export function parseEventEnvelope(rawBody: string): WebhookEvent | null {
  try {
    const j = JSON.parse(rawBody) as { event?: unknown; data?: any };
    if (typeof j?.event !== "string") return null;
    // Charge/transfer events carry data.reference; refund events data.transaction_reference; dispute events data.transaction.reference.
    const d = j.data;
    const candidates = [d?.reference, d?.transaction_reference, d?.transaction?.reference];
    const ref = candidates.find((x) => typeof x === "string") as string | undefined;
    return { type: j.event, reference: ref ?? null };
  } catch {
    return null;
  }
}
