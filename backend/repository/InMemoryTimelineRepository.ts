import type { AnyHealthEvent, AnyHealthEventType, TimeWindow } from "../domain/HealthTimeline";
import type { ISODateTimeString } from "../domain/HealthEvent";
import {
  assertInsightReviewed,
  isInsightEvent,
  type AppendOptions,
  type TimelineRepository,
  type TimelineSnapshot,
  type UserId,
} from "./TimelineRepository";

// In-memory repository (reference implementation)
// - For local testing, unit tests, and demos.
// - NOT production storage.
//
// Enforcement:
// - Append-only (no updates/deletes).
// - Preserves insertion order.
// - Stores immutable snapshots (clones) to prevent mutation through shared references.
// - Enforces InsightEvent review discipline via InsightEvent.reviewStatus only.
// - Validates InsightEvent.evidenceEventIds reference existing events in the timeline.

function cloneSnapshot<T>(value: T): T {
  // Domain events should be plain-data objects.
  // Cloning prevents callers from mutating stored references.
  const sc = (globalThis as any).structuredClone;
  if (typeof sc === "function") return sc(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function isoToMs(iso: ISODateTimeString): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`Invalid timestamp.absolute: ${iso}`);
  return ms;
}

function assertNoDuplicateIds(existing: readonly AnyHealthEvent[], incoming: readonly AnyHealthEvent[]): void {
  const seen = new Set<string>();

  for (const e of existing) seen.add(e.id);

  for (const e of incoming) {
    if (seen.has(e.id)) {
      // Strong guard: duplicate ids imply overwrite/mutation semantics.
      throw new Error(`Append rejected: duplicate HealthEvent.id detected (${e.id}).`);
    }
    seen.add(e.id);
  }
}

function assertEvidenceExists(
  existing: readonly AnyHealthEvent[],
  incoming: readonly AnyHealthEvent[],
): void {
  // InsightEvents reference evidence via evidenceEventIds.
  // Evidence MUST point to non-Insight events only (no Insight-to-Insight chains).
  // This prevents circular reasoning, hallucinated references, and transitive evidence drift.
  const knownNonInsightIds = new Set<string>();
  for (const e of existing) {
    if (!isInsightEvent(e)) knownNonInsightIds.add(e.id);
  }
  for (const e of incoming) {
    if (!isInsightEvent(e)) knownNonInsightIds.add(e.id);
  }

  for (const e of incoming) {
    if (!isInsightEvent(e)) continue;
    for (const refId of e.evidenceEventIds) {
      if (!knownNonInsightIds.has(refId)) {
        throw new Error(
          `InsightEvent append rejected: evidenceEventId "${refId}" is not a non-Insight event in timeline (InsightEvent.id: ${e.id}). Insight-to-Insight evidence chains are forbidden.`,
        );
      }
    }
  }
}

export class InMemoryTimelineRepository implements TimelineRepository {
  private readonly store = new Map<UserId, AnyHealthEvent[]>();

  // Serialize appends per-user to preserve insertion order under concurrent calls.
  private readonly userQueue = new Map<UserId, Promise<void>>();

  // Memory safety: cap per-user events to prevent unbounded growth / OOM DoS.
  static readonly MAX_EVENTS_PER_USER = 10_000;

  private enqueue<T>(userId: UserId, op: () => Promise<T>): Promise<T> {
    const prev = this.userQueue.get(userId) ?? Promise.resolve();

    const next = prev.then(op, op);

    // Ensure queue advances even if an op fails.
    this.userQueue.set(userId, next.then(() => undefined, () => undefined));

    return next;
  }

  async getTimeline(userId: UserId): Promise<TimelineSnapshot> {
    const events = this.store.get(userId) ?? [];
    return {
      userId,
      events: cloneSnapshot(events),
    };
  }

  async appendEvent(userId: UserId, event: AnyHealthEvent, options?: AppendOptions): Promise<void> {
    return this.appendEvents(userId, [event], options);
  }

  async appendEvents(userId: UserId, events: readonly AnyHealthEvent[], _options?: AppendOptions): Promise<void> {
    if (!events.length) return;

    // Enforce review discipline for InsightEvents.
    // IMPORTANT: This relies ONLY on InsightEvent.reviewStatus (no metadata inference).
    for (const e of events) assertInsightReviewed(e);

    return this.enqueue(userId, async () => {
      const existing = this.store.get(userId) ?? [];

      assertNoDuplicateIds(existing, events);
      assertEvidenceExists(existing, events);

      // Memory cap enforcement
      if (existing.length + events.length > InMemoryTimelineRepository.MAX_EVENTS_PER_USER) {
        throw new Error(
          `Append rejected: would exceed per-user limit of ${InMemoryTimelineRepository.MAX_EVENTS_PER_USER} events ` +
          `(current: ${existing.length}, incoming: ${events.length}).`,
        );
      }

      // Append-only: preserve insertion order.
      const clonedIncoming = events.map((e) => cloneSnapshot(e));
      this.store.set(userId, existing.concat(clonedIncoming));
    });
  }

  async getEventsByWindow(userId: UserId, window: TimeWindow): Promise<readonly AnyHealthEvent[]> {
    const events = this.store.get(userId) ?? [];

    const start = isoToMs(window.startAbsolute);
    const end = isoToMs(window.endAbsolute);

    // No sorting: preserve insertion order.
    const slice = events.filter((e) => {
      const t = isoToMs(e.timestamp.absolute);
      return t >= start && t <= end;
    });

    return cloneSnapshot(slice);
  }

  async getEventsByType<TType extends AnyHealthEventType>(
    userId: UserId,
    eventType: TType,
  ): Promise<readonly Extract<AnyHealthEvent, { eventType: TType }>[]> {
    const events = this.store.get(userId) ?? [];

    // No sorting: preserve insertion order.
    const filtered = events.filter((e) => e.eventType === eventType) as Extract<AnyHealthEvent, { eventType: TType }>[];

    return cloneSnapshot(filtered);
  }
}
