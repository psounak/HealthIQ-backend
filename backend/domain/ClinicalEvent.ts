import type { HealthEvent, HealthEventType } from "./HealthEvent";

export interface ClinicalEvent extends HealthEvent<HealthEventType.Clinical> {
  readonly eventType: HealthEventType.Clinical;

  // Occurrence details at a high level (who/where/why). No billing/coding assumptions.
  readonly doctorVisit: string;

  // Optional and only if provided by a clinician or a record.
  readonly diagnosisLabel?: string;
}
