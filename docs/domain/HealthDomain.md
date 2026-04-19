# Health Domain - HealthIQ

## A. Core Principle
- HealthIQ models health as a continuous timeline.
- Events matter more than records.
- Intelligence (later) emerges from patterns across events, not from single entries.

This domain model is descriptive: it captures what happened and what was experienced.
It is not prescriptive: it does not decide what should be done.

## B. Base Entity: HealthEvent
A `HealthEvent` is the parent concept for everything HealthIQ can represent.

### Required Fields
- `id`: stable unique identifier.
- `timestamp`:
  - Absolute: a real-world point in time (e.g., ISO-8601 date-time).
  - Relative: an offset relative to a chosen baseline (e.g., “Day +12 from program start”, “Week 3”).
- `source`: where the event originated.
  - Examples: `user`, `prescription`, `device`, `doctor`.
- `confidenceLevel`: how reliable the event is as an observation.
  - Concept: a graded level (e.g., low/medium/high) or a score.
  - Note: confidence reflects capture reliability, not moral or medical “truth”.
- `visibilityScope`: who is permitted to see the event.
  - Examples: `user-only`, `doctor-shareable`.

### Optional Cross-Cutting Fields (Allowed)
- `duration`: when an event spans time (start + end), not just a point.
- `tags`: user-controlled labels for later grouping.
- `links`: references to related events (`evidence`, `causalContext`, `sameEpisode`).
- `notes`: plain-language, non-AI text.

## C. Specialized Events (Conceptual Extensions)
Each specialized event inherits all `HealthEvent` fields, and adds its own.

### MedicationEvent
- `name`
- `dosage`
- `intendedSchedule`: the plan (what was intended).
- `adherenceOutcome`: what actually happened.
  - Values: `taken`, `missed`, `delayed`.

### SymptomEvent
- `description`
- `intensity`: a user-chosen scale.
- `duration`: how long it persisted (if known).
- `userReportedContext`: what was happening around it (sleep, stress, trigger hints, environment).

### LifestyleEvent
High-level lifestyle signals only (no calorie math, no clinical claims).
- `sleep`
- `stress`
- `activity`
- `food`

### ClinicalEvent
- `doctorVisit`: occurrence details (who/where/why at a high level).
- `diagnosisLabel` (optional): only if provided by a clinician or record.
- `notes`: plain text, non-AI.

### InsightEvent
Insights may be generated later (rule-based or AI-assisted), but they remain domain-bound.

Rules:
- An `InsightEvent` MUST reference other events as evidence.
- An `InsightEvent` MUST NOT be standalone.
- An `InsightEvent` MUST be reversible (it can be superseded later without deleting history).

Explicit constraint:
- InsightEvents cannot exist without evidence.

## D. Timeline Contract
The timeline is the primary representation of health in HealthIQ.

### Ordering
- Primary order is by event time (`timestamp.absolute`).
- Secondary order (when two events share the same time) is by ingestion/creation order.
- Events that span time are treated as intervals that can overlap other intervals and points.

### Coexistence and Overlap
- Overlaps are normal and must be representable (e.g., symptoms during a medication course).
- Multiple events may share a window without forcing a single “winner”.
- Conflicting events are allowed to coexist; conflict is resolved later by interpretation, not by deletion.

### Gaps (Absence Is Data)
- A lack of events in a time window is meaningful (e.g., “no symptoms recorded” is different from “symptoms resolved”).
- Gaps must be preserved as part of the timeline surface.
- Later systems may annotate gaps, but must not rewrite history.

### Immutability (Append-Only)
- The timeline is append-only: events are not edited in place.
- Corrections are represented as new events that reference prior events (e.g., “supersedes”, “clarifies”).
- This supports auditability, trust, and stable downstream interpretation.

## Explicit Non-Goals
HealthIQ does NOT model:
- A diagnosis engine.
- Emergency decision-making.
- Replacement of medical authority.
- Prescription generation.
- Treatment recommendations.
- A billing, coding, or insurance-first record system.
