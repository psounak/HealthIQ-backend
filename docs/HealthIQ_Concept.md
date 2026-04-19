# HealthIQ Concept

## Core Thesis
- Human-first, timeline-based health intelligence that helps people see their health story over time, not just isolated data points.
- Focused on context, transitions, and meaning rather than alerts or task lists.

## Not a Prescription Manager
- HealthIQ does not center on managing prescriptions, refills, or medication adherence workflows.
- It avoids checklist-driven medication management as the primary experience.

## Where Prescriptions Fit
- Prescriptions are one input stream among many (labs, symptoms, habits, events, clinician notes).
- They influence the narrative timeline but do not define it.

## Liquid Pill UI Governance
- Entry Flow: Plan B (Narrative-first) is the default entry experience.
- Scrolling: Scroll reveals health narrative progression rather than screens or cards.
- Transitions: Health states flow as pill expansion and contraction, not page changes.

## Primary User Flow (Bullet Points)
- Entry experience (Plan B):
- Start with a single Primary Pill introducing the current health narrative.
- Micro Pills appear as context fragments, not actions.
- Pill expansion logic:
- Primary Pill expands on intent signals (scroll depth, dwell, or selection).
- Micro Pills can expand into sub-narratives and then collapse back.
- Scroll-to-transition behavior:
- Scrolling morphs the Primary Pill into the next health state rather than switching views.
- The timeline advances via continuous pill transformations.
- Plan A unlocks:
- Plan A (Utility-first) appears only after clear intent is established.
- Intent can be explicit (toggle) or implicit (focused expansion of a Micro Pill).
- How the app feels alive:
- Subtle state shifts based on scroll tempo and pauses.
- Narrative context gently updates without abrupt layout changes.

## Liquid Pill State Model
- Idle
	- Enters: App load, full collapse, or after inactivity timeout.
	- Exits: First scroll input or explicit tap on Primary Pill.
	- Transition type: Scroll-driven or Click-driven.
- Intro
	- Enters: First scroll past Idle threshold or Primary Pill tap from Idle.
	- Exits: Scroll past Intro boundary or direct Micro Pill selection.
	- Transition type: Scroll-driven or Click-driven.
- Skills
	- Enters: Scroll forward from Intro or intent-detected dwell on Skills hint.
	- Exits: Scroll forward to Projects, scroll back to Intro, or micro-pill collapse.
	- Transition type: Scroll-driven or System-driven (intent detection).
- Projects
	- Enters: Scroll forward from Skills or direct Micro Pill navigation.
	- Exits: Scroll forward to Insights, scroll back to Skills, or micro-pill collapse.
	- Transition type: Scroll-driven or Click-driven.
- Insights
	- Enters: Scroll forward from Projects or intent-detected focus on Insights Micro Pill.
	- Exits: Scroll forward to Summary, scroll back to Projects.
	- Transition type: Scroll-driven or System-driven (intent detection).
- Summary
	- Enters: Scroll forward from Insights.
	- Exits: Scroll back to Insights or collapse to Idle (system reset).
	- Transition type: Scroll-driven or System-driven.
- Expanded Micro Narrative (overlay state)
	- Enters: Micro Pill click/selection within any Primary state.
	- Exits: Collapse action or inactivity timeout.
	- Transition type: Click-driven or System-driven.
	- Notes: Does not reorder Primary Pill state sequence; it suspends the current state.

## Plan Switching Logic
- Signals that unlock Plan A:
	- Fast scroll: Two consecutive state transitions within a short time window.
	- Direct Micro Pill navigation: User selects a Micro Pill twice within a session.
	- Repeated state switching: Back-and-forth transitions between two adjacent states more than once.
- When Plan A is active:
	- Scroll behavior: Scroll becomes less resistant at boundaries to favor quick traversal.
	- Navigation availability: Direct navigation between adjacent states is enabled.
	- Pill morphing rules: Morphs are shorter and prioritize speed over narrative dwell.
- Plan B to Plan A switch rules:
	- Plan A remains locked until at least one signal occurs.
	- Plan A activates immediately after any signal is detected.
	- Plan A can be revoked only by explicit user reset or full collapse to Idle.

