# Timeline Contract (Domain -> Liquid Pill)

This document describes how the Liquid Pill UI reads and navigates the health timeline.
It is an interface contract in plain language (no code).

## What The UI Reads
- The UI reads a single, ordered timeline of `HealthEvent` items (points and intervals).
- The UI may request a time window (“segment”) plus adjacent context (before/after).
- The UI may request subsets by visibility scope (e.g., user-only vs doctor-shareable).

## Time Segments And UI States
- The Liquid Pill’s primary states correspond to contiguous time segments, not feature pages.
- A “state” is a narrative slice of time (e.g., “recent”, “this week”, “this month”, “baseline period”).
- Micro Pills represent anchored sub-slices or episodes inside the current time segment.

Contract rules:
- A state MUST map to a time segment.
- A state MUST NOT exist without a definable time range.
- Micro Pills MUST remain subordinate to the primary time segment.

## Why Scroll = Temporal Progression
- Scroll expresses movement along the time axis.
- Forward scroll progresses in time; reverse scroll regresses in time.
- Crossing boundaries between time segments is intentional and must respect resistance rules.

Interpretation constraint:
- Scroll is not direct “positioning”; it is intent that the orchestrator translates into a segment change.

## Plan B Narrative Alignment
Plan B is the default narrative mode.

Plan B rules:
- The primary narrative remains chronological.
- Segment transitions prioritize continuity over speed.
- The UI emphasizes “what changed over time” rather than “what is on the screen”.

## Plan A As A Controlled Exception (Still Timeline-Bound)
Plan A may reduce resistance and enable faster navigation, but it remains timeline-bound.

Plan A rules:
- Navigation can be quicker, but MUST still land on valid time segments.
- Micro Pill focus can open an episode, but MUST reference its position on the timeline.
- Plan A MUST NOT reorder time.

## Evidence And Insight Surfacing
- InsightEvents (when present) are displayed only as overlays or annotations on evidence.
- Insights MUST be navigable back to the supporting events.
- Insights MUST NOT be shown as standalone “tiles” or “cards”.

## Minimal Data Handshake (Conceptual)
- Input to UI: ordered events + a requested time segment definition.
- Output from UI: user intent signals (scroll pressure, select micro, expand/collapse) mapped to segment navigation.
- No other responsibilities live in the UI layer.
