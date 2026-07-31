import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.js";
import type { Clock } from "../../platform/clock/index.js";

/**
 * §16.3 notifications. Quiet hours and the per-payer/assessment cap are both
 * `[A]`-marked in the spec (21:00-08:00 Asia/Karachi; cap of 6) — implemented
 * as configurable constants, not hardcoded as verified fact, per the
 * project's own "no `[A]` circular numbers hardcoded" discipline.
 */
export const QUIET_HOURS_START = 21; // local hour, Asia/Karachi
export const QUIET_HOURS_END = 8;
export const MESSAGE_CAP_PER_PAYER_PER_ASSESSMENT = 6;

export type NotificationEventType =
  | "assessment.issued" | "rtp.received" | "reminder.before_due" | "payment.confirmed"
  | "payment.partial" | "payment.failed" | "instrument.returned" | "refund.initiated"
  | "refund.completed" | "mandate.pre_notification" | "overdue.escalation";

export type NotificationChannel = "SMS" | "EMAIL" | "PUSH" | "LETTER";

export interface SendNotificationInput {
  payerId: string | null;
  assessmentId: string | null;
  eventType: NotificationEventType;
  channel: NotificationChannel;
  /** Local wall-clock hour in Asia/Karachi at send time — the caller
   * resolves this from the injected Clock (this module never reads a real
   * clock itself, same discipline as every other module). */
  localHour: number;
  templateVersion?: string;
}

export type NotificationOutcome = "SENT" | "SUPPRESSED_QUIET_HOURS" | "SUPPRESSED_CAP_REACHED";

function isQuietHours(localHour: number): boolean {
  return localHour >= QUIET_HOURS_START || localHour < QUIET_HOURS_END;
}

/**
 * Rules straight from §16.3's closing paragraph: "Never put a full CNIC/NTN
 * or a full account number in an SMS" (enforced at the template layer, not
 * here — this function receives no raw PII, only IDs); "Respect quiet
 * hours"; "Cap total messages per payer per assessment"; "Every send is
 * logged with template version and delivery status."
 */
export async function sendNotification(db: Kysely<Database>, input: SendNotificationInput, clock: Clock): Promise<{ outcome: NotificationOutcome; logId: string }> {
  const templateVersion = input.templateVersion ?? "v1";

  if (isQuietHours(input.localHour)) {
    const inserted = await db
      .insertInto("notification_log")
      .values({ payer_id: input.payerId, assessment_id: input.assessmentId, event_type: input.eventType, channel: input.channel, template_version: templateVersion, status: "SUPPRESSED_QUIET_HOURS", suppressed_reason: `local hour ${input.localHour} is within quiet hours (${QUIET_HOURS_START}:00-${QUIET_HOURS_END}:00)`, sent_at: clock.now() })
      .returning("id")
      .executeTakeFirstOrThrow();
    return { outcome: "SUPPRESSED_QUIET_HOURS", logId: inserted.id };
  }

  if (input.payerId && input.assessmentId) {
    const sentCount = await db
      .selectFrom("notification_log")
      .select(({ fn }) => fn.countAll().as("c"))
      .where("payer_id", "=", input.payerId)
      .where("assessment_id", "=", input.assessmentId)
      .where("status", "=", "SENT")
      .executeTakeFirstOrThrow();
    if (Number(sentCount.c) >= MESSAGE_CAP_PER_PAYER_PER_ASSESSMENT) {
      const inserted = await db
        .insertInto("notification_log")
        .values({ payer_id: input.payerId, assessment_id: input.assessmentId, event_type: input.eventType, channel: input.channel, template_version: templateVersion, status: "SUPPRESSED_CAP_REACHED", suppressed_reason: `${MESSAGE_CAP_PER_PAYER_PER_ASSESSMENT}-message cap reached for this payer/assessment`, sent_at: clock.now() })
        .returning("id")
        .executeTakeFirstOrThrow();
      return { outcome: "SUPPRESSED_CAP_REACHED", logId: inserted.id };
    }
  }

  const inserted = await db
    .insertInto("notification_log")
    .values({ payer_id: input.payerId, assessment_id: input.assessmentId, event_type: input.eventType, channel: input.channel, template_version: templateVersion, status: "SENT", sent_at: clock.now() })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { outcome: "SENT", logId: inserted.id };
}
