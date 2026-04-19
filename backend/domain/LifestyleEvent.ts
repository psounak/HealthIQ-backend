import type { HealthEvent, HealthEventType } from "./HealthEvent";

export interface LifestyleEvent extends HealthEvent<HealthEventType.Lifestyle> {
  readonly eventType: HealthEventType.Lifestyle;

  // High-level signals only. Avoid false precision.
  readonly sleep?: string;
  readonly stress?: string;
  readonly activity?: string;
  readonly food?: string;
}
