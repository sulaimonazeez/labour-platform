import {
  hmacSha512Matches, parseEventEnvelope, ProviderError, type PaymentProvider, type PayoutGateway, type ProviderTransaction, type VerifyResult,
} from "./provider";

// Paystack adapter (collection side). Verified against Paystack's published behaviour:
//  - amounts are integers in the currency's lowest unit (kobo for NGN), same as our minor units;
//  - POST /transaction/initialize -> data.authorization_url + data.reference (reference must be unique);
//  - GET /transaction/verify/:reference -> data.status ("success" | "failed" | "abandoned" | ...), data.amount, data.currency;
//  - webhooks: x-paystack-signature = hex HMAC-SHA512 of the raw body keyed with the SECRET KEY (no separate webhook secret).

const DEFAULT_BASE = "https://api.paystack.co";

export function createPaystackProvider(secretKey: string, baseUrl: string = DEFAULT_BASE): PaymentProvider {
  async function api(method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new ProviderError(`Paystack unreachable: ${(e as Error).message}`);
    }
    const json: any = await res.json().catch(() => null);
    if (!res.ok || !json || json.status !== true) {
      throw new ProviderError(json?.message ?? `Paystack error (HTTP ${res.status})`, res.status);
    }
    return json;
  }

  // Payouts (Paystack Transfers). Endpoint shapes follow Paystack's published API (transferrecipient, transfer, bank,
  // bank/resolve, transfer/verify) but were NOT exercised against the live API when written: run `npm run live:payout`.
  // Recipient type "nuban" is Nigeria-only; other markets need other recipient types (D57).
  const payouts: PayoutGateway = {
    async listBanks(currency) {
      const json = await api("GET", `/bank?currency=${encodeURIComponent(currency)}&perPage=200`);
      const rows: any[] = Array.isArray(json.data) ? json.data : [];
      return rows.filter((b) => typeof b?.code === "string" && typeof b?.name === "string").map((b) => ({ name: b.name as string, code: b.code as string }));
    },

    async resolveAccount({ accountNumber, bankCode }) {
      const json = await api("GET", `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`);
      const name = json.data?.account_name;
      if (typeof name !== "string" || !name) throw new ProviderError("Paystack could not resolve this account");
      return { accountName: name };
    },

    async createRecipient(i) {
      const json = await api("POST", "/transferrecipient", {
        type: "nuban", name: i.name, account_number: i.accountNumber, bank_code: i.bankCode, currency: i.currency,
      });
      const code = json.data?.recipient_code;
      if (typeof code !== "string") throw new ProviderError("Paystack returned an unexpected recipient response");
      return { recipientCode: code };
    },

    async initiateTransfer(i) {
      const json = await api("POST", "/transfer", {
        source: "balance", amount: i.amountMinor, currency: i.currency, recipient: i.recipientCode, reference: i.reference, reason: i.reason,
      });
      const s = json.data?.status;
      const status = s === "success" ? "paid" : s === "failed" || s === "reversed" ? "failed" : s === "otp" ? "otp_required" : "processing";
      return { status, providerReference: typeof json.data?.reference === "string" ? json.data.reference : i.reference };
    },

    async verifyTransfer(reference) {
      let json: any;
      try {
        json = await api("GET", `/transfer/verify/${encodeURIComponent(reference)}`);
      } catch (e) {
        if (e instanceof ProviderError && (e.httpStatus === 404 || /not found/i.test(e.message))) return { found: false };
        throw e;
      }
      const d = json.data;
      if (!d) throw new ProviderError("Paystack returned an unexpected transfer response");
      const status = d.status === "success" ? "paid" : d.status === "failed" || d.status === "reversed" ? "failed" : "processing";
      return { found: true, status, amountMinor: Number(d.amount), currency: String(d.currency) };
    },
  };

  return {
    code: "paystack",
    payouts,

    async listTransactions({ from, to }) {
      const out: ProviderTransaction[] = [];
      for (let page = 1; page <= 50; page++) {
        const json = await api("GET", `/transaction?perPage=100&page=${page}&from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`);
        const rows: any[] = Array.isArray(json.data) ? json.data : [];
        for (const t of rows) {
          if (typeof t?.reference !== "string") continue;
          out.push({
            reference: t.reference,
            status: t.status === "success" ? "success" : t.status === "failed" ? "failed" : "pending",
            amountMinor: Number(t.amount),
            currency: String(t.currency),
          });
        }
        const pageCount = Number(json.meta?.pageCount ?? 1);
        if (rows.length === 0 || page >= pageCount) break;
      }
      return out;
    },


    async initialize(i) {
      const json = await api("POST", "/transaction/initialize", {
        email: i.email,
        amount: i.amountMinor,
        currency: i.currency,
        reference: i.reference,
        ...(i.callbackUrl ? { callback_url: i.callbackUrl } : {}),
        ...(i.metadata ? { metadata: i.metadata } : {}),
      });
      const d = json.data;
      if (!d || typeof d.authorization_url !== "string" || typeof d.reference !== "string") {
        throw new ProviderError("Paystack returned an unexpected initialize response");
      }
      return { providerReference: d.reference, checkoutUrl: d.authorization_url };
    },

    async verify(reference): Promise<VerifyResult> {
      let json: any;
      try {
        json = await api("GET", `/transaction/verify/${encodeURIComponent(reference)}`);
      } catch (e) {
        if (e instanceof ProviderError && (e.httpStatus === 404 || /not found/i.test(e.message))) return { found: false };
        throw e;
      }
      const d = json.data;
      if (!d) throw new ProviderError("Paystack returned an unexpected verify response");
      const status = d.status === "success" ? "success" : d.status === "failed" ? "failed" : "pending";
      return {
        found: true,
        status,
        amountMinor: Number(d.amount),
        currency: String(d.currency),
        channel: typeof d.channel === "string" ? d.channel : null,
      };
    },

    verifyWebhookSignature: (raw, sig) => hmacSha512Matches(secretKey, raw, sig),
    parseWebhook: parseEventEnvelope,
  };
}
