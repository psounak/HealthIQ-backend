import type { EventSource } from "./EventSource";
import type { VisibilityScope } from "./VisibilityScope";

// NOTE: These are domain contracts only.
// - No persistence assumptions.
// - No AI conclusions.
// - No in-place mutation: fields are readonly.

export type ISODateTimeString = string;

export type ConfidenceLevel = "low" | "medium" | "high";

export type NonEmptyArray<T> = readonly [T, ...T[]];

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | { readonly [k: string]: JsonValue } | readonly JsonValue[];

export interface RelativeTimestamp {
  // Example: reference = "program_start"; offset = "Day +12".
  readonly reference: string;
  readonly offset: string;
}

export interface HealthEventTimestamp {
  // MUST be an ISO-8601 date-time string.
  readonly absolute: ISODateTimeString;

  // Optional, human-first relative time that does not claim precision.
  readonly relative?: RelativeTimestamp;
}

export type EventDuration =
  | {
      // A concrete interval on the timeline.
      readonly kind: "interval";
      readonly startAbsolute: ISODateTimeString;
      readonly endAbsolute: ISODateTimeString;
    }
  | {
      // A user-reported duration string (e.g., "about 2 hours", "since morning").
      readonly kind: "reported";
      readonly value: string;
    };

export interface HealthEventLinks {
  // Links are references to other HealthEvent ids.
  readonly evidence?: readonly string[];
  readonly causalContext?: readonly string[];
  readonly sameEpisode?: readonly string[];

  // Append-only correction semantics.
  readonly supersedes?: readonly string[];
  readonly clarifies?: readonly string[];
}

export enum HealthEventType {
  Medication = "Medication",
  Symptom = "Symptom",
  Lifestyle = "Lifestyle",
  Clinical = "Clinical",
  Insight = "Insight",
}

export interface HealthEvent<TType extends HealthEventType = HealthEventType> {
  readonly id: string;
  readonly eventType: TType;

  readonly timestamp: HealthEventTimestamp;
  readonly source: EventSource;

  // Confidence reflects capture/interpretation reliability, not disease likelihood.
  readonly confidence: ConfidenceLevel;

  readonly visibilityScope: VisibilityScope;

  // Extensible but typed. Must not store AI conclusions here.
  readonly metadata?: Readonly<Record<string, JsonValue>>;

  // Optional cross-cutting fields.
  readonly duration?: EventDuration;
  readonly tags?: readonly string[];
  readonly links?: HealthEventLinks;

  // Plain-language note. If used for AI-assisted insights later, it MUST be human-reviewed first.
  readonly notes?: string;
}
