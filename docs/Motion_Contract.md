# Motion Contract - Liquid Pill UI

This document defines the allowed motion behaviors and sequencing logic.
It is a physics-style contract, not an animation specification.

## Allowed Transitions
- Expand: Primary pill increases its narrative volume while maintaining continuity.
- Morph: Primary and micro structures reshape without breaking containment.
- Compress: Primary pill reduces to a thinner narrative band without collapsing content order.
- Settle: Motion concludes by easing into a stable state without jitter.

## Forbidden Transitions
- Snap: No instant jumps between narrative positions.
- Fade-cut: No cutaway transitions that hide state continuity.
- Teleport: No appearance of elements in new positions without travel.

## Timing Philosophy
- Timing is relative, not specified in milliseconds.
- Cause must precede effect with a perceptible handoff.
- Motion duration scales with the distance traveled in the narrative track.

## Cause -> Effect Sequencing
- Intent signals are collected first.
- The state machine decides the next valid state.
- Motion expresses the decision, never the other way around.
- Completion of motion confirms state, notifies orchestrator, and unlocks next input.

## Scroll -> Motion Mapping
- Scroll is treated as continuous intent, not direct position control.
- Scroll pressure increases until resistance yields, then motion begins.
- Releasing scroll before crossing resistance returns to the current state.

## Resistance Concept
- Resistance is felt as delayed response near boundaries.
- Resistance communicates state stability rather than blocking progress.
- Plan A reduces resistance; Plan B preserves it.
