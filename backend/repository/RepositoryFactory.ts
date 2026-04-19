import type { TimelineRepository } from "./TimelineRepository";
import { InMemoryTimelineRepository } from "./InMemoryTimelineRepository";

// Repository Factory (HealthIQ v2 — LocalStorage-first)
// - Always returns InMemoryTimelineRepository.
// - The server is a stateless compute service; user data lives in client LocalStorage.
// - This factory must not introduce auth, DB, UI, Maps, or infrastructure commitments.

let singleton: TimelineRepository | undefined;

export function getTimelineRepository(): TimelineRepository {
  if (!singleton) {
    console.log("[HealthIQ] Using in-memory repository (stateless server)");
    singleton = new InMemoryTimelineRepository();
  }
  return singleton;
}
