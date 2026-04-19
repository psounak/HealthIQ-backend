import type { AnyHealthEvent, AnyHealthEventType, TimeWindow } from "../domain/HealthTimeline";
import type { InsightEvent } from "../domain/InsightEvent";

// Repository Boundary (HealthIQ)
// - This is the ONLY layer that reads/writes timelines.
// - No AI, no UI, no Maps logic.
// - Repository does not interpret health data; it enforces structural invariants only.
//
// Append-only guarantees:
// - No update() / delete() methods exist.
// - Stored events are immutable snapshots.
// - Corrections happen by appending new events that reference prior ones.
//
// Insight review discipline:
// - InsightEvents are only persistable when explicitly reviewed.
// - Repository enforcement is based ONLY on InsightEvent.reviewStatus.
// - Metadata MUST NOT be used to infer review state.

export type UserId = string;

export type TimelineSnapshot = Readonly<{
  userId: UserId;
  events: readonly AnyHealthEvent[];
}>;

export type AppendOptions = Readonly<{
  // Optional correlation id for tracing (no interpretation).
  requestId?: string;
}>;

export interface TimelineRepository {
  getTimeline(userId: UserId): Promise<TimelineSnapshot>;

  // Append-only write: adds a new event to the end of the user's timeline.
  // Repository MUST reject in-place mutation semantics (e.g., duplicate id overwrites).
  appendEvent(userId: UserId, event: AnyHealthEvent, options?: AppendOptions): Promise<void>;

  // Bulk append retains input order.
  appendEvents(userId: UserId, events: readonly AnyHealthEvent[], options?: AppendOptions): Promise<void>;

  // Read-only helpers.
  getEventsByWindow(userId: UserId, window: TimeWindow): Promise<readonly AnyHealthEvent[]>;
  getEventsByType<TType extends AnyHealthEventType>(
    userId: UserId,
    eventType: TType,
  ): Promise<readonly Extract<AnyHealthEvent, { eventType: TType }>[]>;
}

export function isInsightEvent(event: AnyHealthEvent): event is InsightEvent {
  return event.eventType === "Insight";
}

export function assertInsightReviewed(event: AnyHealthEvent): void {
  // Enforces: InsightEvents cannot be appended unless explicitly reviewed.
  if (!isInsightEvent(event)) return;

  if (event.reviewStatus !== "reviewed") {
    throw new Error("InsightEvent append rejected: reviewStatus must be \"reviewed\".");
  }
}
