import type { ClinicalEvent } from "./ClinicalEvent";
import type { InsightEvent } from "./InsightEvent";
import type { LifestyleEvent } from "./LifestyleEvent";
import type { MedicationEvent } from "./MedicationEvent";
import type { SymptomEvent } from "./SymptomEvent";
import type { ISODateTimeString } from "./HealthEvent";

// Timeline is the primary model of health in HealthIQ.
// Contract:
// - Ordered collection of events (array order encodes secondary ordering).
// - Append-only: adding returns a new timeline.
// - Prohibits in-place mutation of events and the timeline collection.

export type AnyHealthEvent =
  | MedicationEvent
  | SymptomEvent
  | LifestyleEvent
  | ClinicalEvent
  | InsightEvent;

export type AnyHealthEventType = AnyHealthEvent["eventType"];

export type EventsByType<TType extends AnyHealthEventType> = Extract<AnyHealthEvent, { eventType: TType }>;

export interface TimeWindow {
  readonly startAbsolute: ISODateTimeString;
  readonly endAbsolute: ISODateTimeString;
}

export interface HealthTimeline {
  readonly events: readonly AnyHealthEvent[];

  // Returns a new timeline with the event appended.
  addEvent: (event: AnyHealthEvent) => HealthTimeline;

  // Returns a new array; must not expose mutable internal collections.
  getEventsByTimeWindow: (window: TimeWindow) => readonly AnyHealthEvent[];

  getEventsByType: <TType extends AnyHealthEventType>(eventType: TType) => readonly EventsByType<TType>[];
}
