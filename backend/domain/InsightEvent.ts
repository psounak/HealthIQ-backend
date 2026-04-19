import type { HealthEvent, HealthEventType, NonEmptyArray } from "./HealthEvent";

export type InsightReviewStatus = "draft" | "reviewed";

export interface InsightEvent extends HealthEvent<HealthEventType.Insight> {
  readonly eventType: HealthEventType.Insight;

  // Evidence discipline:
  // - InsightEvents cannot exist without evidence.
  // - These ids must reference existing HealthEvents.
  readonly evidenceEventIds: NonEmptyArray<string>;

  // Review discipline (first-class, persistent, auditable):
  // - Default MUST be "draft".
  // - "reviewed" requires explicit human confirmation.
  // - AI-generated insight drafts MUST always start as "draft".
  //
  // IMPORTANT:
  // - Review status MUST NOT be inferred from metadata.
  // - Any existing metadata-based review flags are TEMPORARY (deprecated).
  readonly reviewStatus: InsightReviewStatus;
}
