import { ApiError } from "../api/http";
import { createPaystackProvider } from "./paystack";
import type { PaymentProvider } from "./provider";
import { sandboxProvider } from "./sandbox";

// Provider selection is configuration, not code (PRD §47).
//   PAYMENTS_PROVIDER=sandbox|paystack   (default sandbox; sandbox is refused when NODE_ENV=production)
//   PAYSTACK_SECRET_KEY=sk_test_... / sk_live_...
//   PAYSTACK_BASE_URL (optional), PAYMENTS_CALLBACK_URL (optional, where the gateway sends the customer back)

let cached: { code: string; provider: PaymentProvider } | null = null;

export function getPaymentProvider(): PaymentProvider {
  const code = (process.env.PAYMENTS_PROVIDER ?? "sandbox").trim().toLowerCase();
  if (cached && cached.code === code) return cached.provider;

  let provider: PaymentProvider;
  if (code === "sandbox") {
    if (process.env.NODE_ENV === "production") {
      throw new ApiError(503, "payments_not_configured", "The sandbox payment provider is disabled in production");
    }
    provider = sandboxProvider;
  } else if (code === "paystack") {
    const key = process.env.PAYSTACK_SECRET_KEY?.trim();
    if (!key) throw new ApiError(503, "payments_not_configured", "PAYSTACK_SECRET_KEY is not set");
    provider = createPaystackProvider(key, process.env.PAYSTACK_BASE_URL?.trim() || undefined);
  } else {
    throw new ApiError(503, "payments_not_configured", `Unknown PAYMENTS_PROVIDER "${code}"`);
  }
  cached = { code, provider };
  return provider;
}
