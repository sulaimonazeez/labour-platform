import { createHmac } from "node:crypto";
import {
  hmacSha512Matches, parseEventEnvelope, ProviderError, type PaymentProvider, type PayoutGateway,
} from "./provider.js";

// In-process fake gateway for tests and local development. It can only be told a payment succeeded through
// simulateSandboxPayment() (a function call), never over HTTP, and getPaymentProvider() refuses it in production.

type Record_ = { amountMinor: number; currency: string; status: "pending" | "success" | "failed" };
const records = new Map<string, Record_>();

type Transfer_ = { amountMinor: number; currency: string; status: "processing" | "paid" | "failed" };
const transfers = new Map<string, Transfer_>();

const sandboxPayouts: PayoutGateway = {
  async listBanks() {
    return [{ name: "Sandbox Bank", code: "000" }];
  },
  async resolveAccount({ accountNumber }) {
    if (accountNumber.endsWith("0000")) throw new ProviderError("Could not resolve account name");
    return { accountName: "SANDBOX ACCOUNT HOLDER" };
  },
  async createRecipient(i) {
    return { recipientCode: `RCP_sandbox_${i.bankCode}_${i.accountNumber.slice(-4)}` };
  },
  async initiateTransfer(i) {
    if (transfers.has(i.reference)) throw new ProviderError("Transfer reference already in use");
    transfers.set(i.reference, { amountMinor: i.amountMinor, currency: i.currency, status: "processing" });
    return { status: "processing", providerReference: i.reference };
  },
  async verifyTransfer(reference) {
    const t = transfers.get(reference);
    if (!t) return { found: false };
    return { found: true, status: t.status, amountMinor: t.amountMinor, currency: t.currency };
  },
};

const secret = () => process.env.SANDBOX_WEBHOOK_SECRET ?? "sandbox-webhook-secret";

export const sandboxProvider: PaymentProvider = {
  code: "sandbox",

  async initialize(i) {
    if (records.has(i.reference)) throw new ProviderError("Duplicate Transaction Reference");
    records.set(i.reference, { amountMinor: i.amountMinor, currency: i.currency, status: "pending" });
    return { providerReference: i.reference, checkoutUrl: `https://sandbox.invalid/pay/${i.reference}` };
  },

  async verify(reference) {
    const r = records.get(reference);
    if (!r) return { found: false };
    return { found: true, status: r.status, amountMinor: r.amountMinor, currency: r.currency, channel: "sandbox" };
  },

  verifyWebhookSignature: (raw, sig) => hmacSha512Matches(secret(), raw, sig),
  parseWebhook: parseEventEnvelope,
  payouts: sandboxPayouts,
};

export function simulateSandboxPayment(reference: string, outcome: "success" | "failed" = "success"): void {
  const r = records.get(reference);
  if (!r) throw new Error(`sandbox: unknown reference ${reference}`);
  r.status = outcome;
}

export function signSandboxWebhook(rawBody: string): string {
  return createHmac("sha512", secret()).update(rawBody).digest("hex");
}

export function simulateSandboxTransfer(reference: string, outcome: "paid" | "failed" = "paid"): void {
  const t = transfers.get(reference);
  if (!t) throw new Error(`sandbox: unknown transfer ${reference}`);
  t.status = outcome;
}
