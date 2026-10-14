import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { activityEvents, payments } from "../db/schema/index.js";
import { recordActivity } from "../lib/activity.js";
import type { WebhookEvent } from "./provider.js";

// Refund / dispute / chargeback events are LOGGED and surfaced to a human (GET /admin/attention), never applied to
// money automatically: we have not yet seen their real payloads (D54). Dedupe is by the SHA-256 of the raw body, so a
// gateway retry does not create a second alert.

export const GATEWAY_ALERT_EVENT = /^(refund|charge\.dispute|chargeback)/;

export async function logGatewayEvent(providerCode: string, raw: string, event: WebhookEvent): Promise<{ handled: boolean }> {
  const bodySha256 = createHash("sha256").update(raw).digest("hex");
  return db.transaction(async (tx) => {
    const [seen] = await tx.select({ id: activityEvents.id }).from(activityEvents)
      .where(and(eq(activityEvents.eventType, "gateway.event_received"), sql`${activityEvents.payload}->>'bodySha256' = ${bodySha256}`)).limit(1);
    if (seen) return { handled: false };

    let payment: { id: string; projectId: string } | undefined;
    if (event.reference) {
      [payment] = await tx.select({ id: payments.id, projectId: payments.projectId }).from(payments)
        .where(and(eq(payments.providerCode, providerCode), eq(payments.providerReference, event.reference))).limit(1);
    }
    await recordActivity(tx, {
      projectId: payment?.projectId ?? null,
      actorType: "provider_webhook",
      eventType: "gateway.event_received",
      subjectType: payment ? "payment" : "gateway_event",
      subjectId: payment?.id ?? null,
      payload: { providerCode, eventType: event.type, reference: event.reference, bodySha256 },
    });
    return { handled: true };
  });
}
