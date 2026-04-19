# Liquid Pill Interaction Rules

## Scroll Thresholds
- Scroll is mapped to state boundaries using fixed thresholds per state segment.
- Thresholds must be documented as percentages of a normalized 0-100 narrative track.
- Partial scroll within a state never jumps to a non-adjacent state.

## Boundary Resistance
- Approaching a state boundary increases resistance to prevent accidental transitions.
- Resistance increases progressively within the last 15% of a state segment.
- Crossing a boundary requires sustained scroll beyond the resistance band.

## Glass-Scroll Activation
- Glass-scroll activates only when the Primary Pill is expanded.
- Glass-scroll is disabled during Intro to avoid premature deep navigation.
- Glass-scroll activation is system-driven and must not be toggled by arbitrary UI.

## Collapse Behavior
- Scroll-to-top triggers a controlled collapse sequence.
- Collapse includes resistance within the first 10% above the top boundary.
- Collapse must return to Idle, not skip to any other state.

## Anti-Patterns (Must NEVER Happen)
- Never jump multiple states from a single scroll gesture.
- Never switch Plan B to Plan A without explicit or repeated intent signals.
- Never allow Micro Pills to override Primary Pill state ordering.
- Never allow Plan A to disable narrative state continuity.
- Never allow the pill to fragment into multiple primary states simultaneously.

## Explicit Anti-Patterns
- Multiple visible primary containers in the same view.
- Dashboards or card grids masquerading as pill structures.
- Scroll hijacking without boundary resistance feedback.
- Independent component animations that ignore the shared motion contract.
- Micro Pills initiating non-adjacent primary state jumps.
- Any transition that violates the allowed motion contract.
