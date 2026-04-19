# AI Task Contracts - HealthIQ

This document defines the only AI-allowed tasks in HealthIQ.
It specifies purpose, inputs, outputs, and safety constraints.
No task below is a diagnosis, treatment, or emergency system.

## Shared Input Vocabulary (Domain-Aligned)
- Inputs are always derived from the HealthIQ domain timeline (see `docs/domain/HealthDomain.md`).
- `HealthEvent` references MUST be by `id`.
- Any text supplied by the user is treated as untrusted and may be ambiguous.

## Task 1: Symptom Interpretation

### Purpose
Convert raw symptom text into structured, human-reviewable understanding.

### Input
- Required: user-reported `SymptomEvent` items (text + intensity/duration/context when available)
- Optional: recent `MedicationEvent` items (name/dosage/schedule/adherenceOutcome)
- Optional: recent `LifestyleEvent` items (sleep/stress/activity/food at a high level)

### Output (STRICT)
- `symptomLabels`: list of normalized symptom labels (non-diagnostic)
- `labelConfidence`: confidence per label (capture/interpretation confidence, not disease likelihood)
- `evidenceEventIds`: list of referenced `HealthEvent.id` values used to produce each label

### Rules
- No diagnosis.
- No probabilities of disease.
- No treatment advice.
- Output must remain symptom-level (what is experienced), not condition-level (what it �is�).

## Task 2: Health Pattern Insight

### Purpose
Detect patterns across timeline events within an explicit time window.

### Input
- Required: `HealthEvent` timeline slice (points and intervals)
- Required: explicit time window definition (start/end or segment label mapped to time)

### Output
- `insightDraft`: an `InsightEvent` draft (not yet saved)
- `supportingEventIds`: referenced supporting evidence event IDs
- `confidenceExplanation`: plain-language explanation of why the insight is believed, with uncertainty noted

### Rules
- Insight must cite evidence (by event IDs).
- Insight must be reversible/contestable (it can be superseded later; never treated as final truth).
- No predictive medical claims.
- No claims of causality unless explicitly framed as a hypothesis with uncertainty.

## Task 3: Medical Specialization Suggestion

### Purpose
Suggest which kind of clinician specialization may be relevant (not a diagnosis).
This prepares for later doctor search integrations.

### Input
- Required: structured symptom labels (from Task 1 outputs)
- Optional: `InsightEvent` drafts or saved InsightEvents (if any)

### Output
- `specializations`: list of medical specializations (e.g., dermatology, gastroenterology)
- `reasonPerSpecialization`: short reason for each specialization based on symptoms/insights
- `uncertaintyNote`: explicit statement of uncertainty and limitations

### Rules
- No doctor names.
- No location.
- No urgency grading.
- No claims that a specialization is definitively required.

## Task 4: Doctor-Visit Summary

### Purpose
Help the user prepare for a consultation by aggregating relevant timeline information.

### Input
- Required: selected timeline window (explicit start/end or segment)
- Required: relevant events (by ID) within or adjacent to the window

### Output
- `summary`: neutral, factual, chronological summary
- `includedEventIds`: the event IDs included in the summary
- `uncertainties`: explicit list of missing/uncertain information (e.g., unclear onset, missing duration)

### Rules
- No advice.
- No filtering that hides uncertainty.
- No interpretation beyond aggregation and normalization (e.g., ordering, deduping identical entries).

## Forbidden AI Capabilities

HealthIQ AI must NEVER:
- Diagnose conditions (e.g., "You have X").
- Replace medical professionals.
- Generate prescriptions or dosage instructions.
- Provide emergency decision making beyond advising to seek immediate care.
- Prioritize doctors or hospitals.
- Provide treatment plans, medication changes, or dosage guidance.
- Produce "you should" instructions framed as medical directives.
- State definitive medical conclusions (e.g., "This is definitely...").

## Permitted AI Capabilities (Health Chat Only)

HealthIQ AI IS allowed to:
- Provide general health education (e.g., "What causes headaches?").
- Explain common symptoms and what they may generally indicate.
- Offer preventive health guidance and lifestyle suggestions.
- Give condition overviews (e.g., general information about diabetes).
- Discuss how lifestyle factors (sleep, stress, diet, exercise) affect health.
- Reference the user's timeline data for personalized context.
- Explain medical terms in plain language.
- Use educational, uncertainty-framed language (e.g., "commonly associated with", "may be related to").

These capabilities apply to the conversational Health Chat task only.
Tasks 1-4 (Symptom Interpretation, Pattern Insight, Specialization, Doctor-Visit Summary) retain their strict output-only contracts.

## Task 5: Health Chat

### Purpose
Provide conversational, educational health information to users in a warm, informative tone.
This task is the user-facing conversational interface — not a clinical tool.

### Input
- Required: user's free-text message
- Optional: recent timeline events (sanitized, limited to last 20)

### Output (STRICT JSON)
- `reply`: educational, uncertainty-framed response to the user's question
- `disclaimer`: mandatory safety clause appended to every response

### Rules
- Allowed: general health education, symptom explanations, preventive guidance, lifestyle suggestions, condition overviews.
- Forbidden: diagnosis, prescriptions, dosage instructions, definitive medical claims, emergency directives.
- Emergency keywords (chest pain, difficulty breathing, severe bleeding, etc.) must trigger a "seek immediate care" response without diagnosis.
- All responses must use uncertainty framing (e.g., "may", "often", "commonly associated with").
- A disclaimer is always included in the response.

### Boundary
This is a conversational task. No evidence discipline or review-first policy applies.
The user does not review or approve Health Chat responses before seeing them.

## AI and Timeline Interaction Rules
- AI cannot create `HealthEvent` entries directly.
- AI outputs must be reviewed by the user (or an authorized clinician workflow) before being saved.
- AI outputs always reference timeline data (by `HealthEvent.id`).
- If an AI output is saved, it is saved as an `InsightEvent` (append-only) and must reference evidence.
- InsightEvents are append-only: corrections/superseding insights are new events that reference prior insights.
- Deleting or rewriting evidence events is forbidden; uncertainty is handled by new events and revised insights.

## Future Integration Note (Non-Implementation)
- A later Google Maps doctor lookup may consume Task 3 outputs (`specializations`) plus user-provided location.
- This contract does not allow the AI to select specific doctors, rank providers, or infer urgency.
