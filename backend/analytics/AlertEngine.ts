import type { AnyHealthEvent } from "../domain/HealthTimeline";
import { HealthEventType } from "../domain/HealthEvent";
import type { MedicationEvent } from "../domain/MedicationEvent";
import type { SymptomEvent } from "../domain/SymptomEvent";
import type { HSIScore } from "./HSIScorer";
import type { GraphSummary } from "./HealthGraphBuilder";

// =========================================================================
// HealthIQ v2 — Alert Engine (Stateless)
//
// Evaluates built-in alert rules against a user's health state.
// Client sends events + HSI, server evaluates and returns alerts.
// No server-side persistence — alerts are stored in client LocalStorage.
//
// Rules are TEMPLATE-DRIVEN, not LLM-generated.
//
// Alert severity levels:
//   info     — informational, no action needed
//   warning  — monitor closely, consider seeking patterns
//   attention — review recommended
// =========================================================================

export type AlertSeverity = "info" | "warning" | "attention";

export interface UserAlert {
  id: string;
  ruleType: string;
  triggeredAt: string;
  severity: AlertSeverity;
  title: string;
  explanation: string;
  evidenceIds: string[];
}

export interface AlertEvaluationContext {
  currentHSI: HSIScore;
  previousHSI?: HSIScore | null;
  events: readonly AnyHealthEvent[];
  graphSummary?: GraphSummary;
}

// =========================================================================
// Built-in alert evaluation rules
// =========================================================================

function evaluateHSIDrop(ctx: AlertEvaluationContext): UserAlert | null {
  if (!ctx.previousHSI) return null;
  const delta = ctx.currentHSI.score - ctx.previousHSI.score;
  if (delta >= -9) return null;

  return {
    id: `alert-hsi-${Date.now()}`,
    ruleType: "hsi_drop",
    triggeredAt: new Date().toISOString(),
    severity: "warning",
    title: "Health Stability Index declined significantly",
    explanation: `Your HSI dropped from ${Math.round(ctx.previousHSI.score)} to ${Math.round(ctx.currentHSI.score)} (${Math.round(delta)} points). This may reflect changes in your symptom patterns, medication adherence, or lifestyle factors.`,
    evidenceIds: ctx.currentHSI.contributingEventIds.slice(0, 10),
  };
}

function evaluateNewSymptomCluster(ctx: AlertEvaluationContext): UserAlert | null {
  const now = Date.now();
  const fourteenDaysAgo = now - 14 * 24 * 60 * 60 * 1000;
  const sixtyDaysAgo = now - 60 * 24 * 60 * 60 * 1000;

  const symptomEvents = ctx.events.filter(
    (e): e is SymptomEvent => e.eventType === HealthEventType.Symptom,
  );

  const recentSymptoms = new Set<string>();
  const recentEventIds: string[] = [];
  for (const e of symptomEvents) {
    const t = new Date(e.timestamp.absolute).getTime();
    if (t >= fourteenDaysAgo) {
      recentSymptoms.add(e.description.toLowerCase().trim());
      recentEventIds.push(e.id);
    }
  }

  const olderSymptoms = new Set<string>();
  for (const e of symptomEvents) {
    const t = new Date(e.timestamp.absolute).getTime();
    if (t >= sixtyDaysAgo && t < fourteenDaysAgo) {
      olderSymptoms.add(e.description.toLowerCase().trim());
    }
  }

  const newSymptoms = [...recentSymptoms].filter((s) => !olderSymptoms.has(s));
  if (newSymptoms.length < 3) return null;

  return {
    id: `alert-cluster-${Date.now()}`,
    ruleType: "new_symptom_cluster",
    triggeredAt: new Date().toISOString(),
    severity: "attention",
    title: `${newSymptoms.length} new symptom types in the past 2 weeks`,
    explanation: `You've reported ${newSymptoms.length} symptom types in the last 14 days that weren't present before. New symptoms: ${newSymptoms.slice(0, 5).join(", ")}.`,
    evidenceIds: recentEventIds.slice(0, 10),
  };
}

function evaluateAdherenceDecline(ctx: AlertEvaluationContext): UserAlert | null {
  const now = Date.now();
  const fourteenDaysAgo = now - 14 * 24 * 60 * 60 * 1000;

  const recentMeds = ctx.events.filter(
    (e): e is MedicationEvent =>
      e.eventType === HealthEventType.Medication &&
      new Date(e.timestamp.absolute).getTime() >= fourteenDaysAgo,
  );

  if (recentMeds.length < 5) return null;

  const taken = recentMeds.filter((e) => e.adherenceOutcome === "taken").length;
  const adherenceRate = (taken / recentMeds.length) * 100;

  if (adherenceRate >= 70) return null;

  return {
    id: `alert-adherence-${Date.now()}`,
    ruleType: "adherence_decline",
    triggeredAt: new Date().toISOString(),
    severity: "warning",
    title: "Medication adherence has decreased",
    explanation: `Your medication adherence over the past 14 days is ${Math.round(adherenceRate)}% (${taken} of ${recentMeds.length} doses taken).`,
    evidenceIds: recentMeds.map((e) => e.id).slice(0, 10),
  };
}

function evaluateLoggingGap(ctx: AlertEvaluationContext): UserAlert | null {
  if (ctx.events.length < 20) return null;

  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

  const hasRecentEvent = ctx.events.some(
    (e) => new Date(e.timestamp.absolute).getTime() >= sevenDaysAgo,
  );

  if (hasRecentEvent) return null;

  const lastEvent = ctx.events[ctx.events.length - 1];
  const daysSinceLast = Math.round(
    (now - new Date(lastEvent.timestamp.absolute).getTime()) / (1000 * 60 * 60 * 24),
  );

  return {
    id: `alert-gap-${Date.now()}`,
    ruleType: "logging_gap",
    triggeredAt: new Date().toISOString(),
    severity: "info",
    title: `No health events logged in ${daysSinceLast} days`,
    explanation: `It's been ${daysSinceLast} days since your last health event. Regular logging helps HealthIQ provide better insights.`,
    evidenceIds: [],
  };
}

function evaluateSymptomEscalation(ctx: AlertEvaluationContext): UserAlert | null {
  const symptomEvents = ctx.events.filter(
    (e): e is SymptomEvent => e.eventType === HealthEventType.Symptom,
  );

  if (symptomEvents.length < 3) return null;

  const byDescription = new Map<string, SymptomEvent[]>();
  for (const e of symptomEvents) {
    const key = e.description.toLowerCase().trim();
    const group = byDescription.get(key) || [];
    group.push(e);
    byDescription.set(key, group);
  }

  for (const [desc, events] of byDescription) {
    if (events.length < 3) continue;

    const sorted = [...events].sort(
      (a, b) => new Date(a.timestamp.absolute).getTime() - new Date(b.timestamp.absolute).getTime(),
    );

    const intensities: { event: SymptomEvent; value: number }[] = [];
    for (const e of sorted) {
      if (!e.intensity) continue;
      const match = e.intensity.match(/(\d+(?:\.\d+)?)/);
      if (match) intensities.push({ event: e, value: parseFloat(match[1]) });
    }

    if (intensities.length >= 3) {
      const last = intensities.slice(-3);
      const allIncreasing = last.every((item, i) => i === 0 || item.value > last[i - 1].value);

      if (allIncreasing) {
        return {
          id: `alert-escalation-${Date.now()}`,
          ruleType: "symptom_escalation",
          triggeredAt: new Date().toISOString(),
          severity: "warning",
          title: `"${desc}" intensity increasing`,
          explanation: `The intensity of "${desc}" has increased across the last ${last.length} occurrences (${last.map((l) => l.value).join(" → ")}).`,
          evidenceIds: last.map((l) => l.event.id),
        };
      }
    }
  }

  return null;
}

function evaluateCoOccurrenceSpike(ctx: AlertEvaluationContext): UserAlert | null {
  if (!ctx.graphSummary) return null;

  const highWeightEdges = ctx.graphSummary.strongestEdges.filter((e) => e.weight >= 4.0);
  if (highWeightEdges.length === 0) return null;

  const topEdge = highWeightEdges[0];
  return {
    id: `alert-cooccurrence-${Date.now()}`,
    ruleType: "co_occurrence_spike",
    triggeredAt: new Date().toISOString(),
    severity: "info",
    title: "Strong health pattern detected",
    explanation: `A frequent co-occurrence between "${topEdge.sourceConcept || "factor A"}" and "${topEdge.targetConcept || "factor B"}" has been detected (strength: ${topEdge.weight.toFixed(1)}).`,
    evidenceIds: [],
  };
}

// =========================================================================
// Main evaluation — stateless, returns all triggered alerts
// =========================================================================

export function evaluateAlerts(ctx: AlertEvaluationContext): UserAlert[] {
  const alerts: UserAlert[] = [];

  // Cold start protection
  if (ctx.events.length < 10) return alerts;
  const firstEventTime = new Date(ctx.events[0]?.timestamp?.absolute || 0).getTime();
  const daysSinceFirst = (Date.now() - firstEventTime) / (1000 * 60 * 60 * 24);
  if (daysSinceFirst < 14) return alerts;

  const hsiDrop = evaluateHSIDrop(ctx);
  if (hsiDrop) alerts.push(hsiDrop);

  const newCluster = evaluateNewSymptomCluster(ctx);
  if (newCluster) alerts.push(newCluster);

  const adherence = evaluateAdherenceDecline(ctx);
  if (adherence) alerts.push(adherence);

  const gap = evaluateLoggingGap(ctx);
  if (gap) alerts.push(gap);

  const escalation = evaluateSymptomEscalation(ctx);
  if (escalation) alerts.push(escalation);

  const spike = evaluateCoOccurrenceSpike(ctx);
  if (spike) alerts.push(spike);

  return alerts;
}

// =========================================================================
// Risk stratification
// =========================================================================

export type RiskLevel = "green" | "yellow" | "orange";

export interface RiskStatus {
  level: RiskLevel;
  hsiScore: number;
  activeAlertCount: number;
  warningCount: number;
  attentionCount: number;
  description: string;
}

export function computeRiskLevel(hsi: HSIScore, alerts: UserAlert[]): RiskStatus {
  const warnings = alerts.filter((a) => a.severity === "warning").length;
  const attentions = alerts.filter((a) => a.severity === "attention").length;
  const totalActive = alerts.length;

  let level: RiskLevel;
  let description: string;

  if (hsi.score < 40 || totalActive >= 3) {
    level = "orange";
    description = "Your health trajectory shows patterns that deserve attention. Consider reviewing your recent health data and discussing changes with a healthcare professional.";
  } else if (hsi.score < 70 || warnings >= 1 || attentions >= 1) {
    level = "yellow";
    description = "Some health patterns have been flagged. Consider reviewing the alert details.";
  } else {
    level = "green";
    description = "Your health trajectory appears stable. Continue logging health events for the most accurate tracking.";
  }

  return {
    level,
    hsiScore: hsi.score,
    activeAlertCount: totalActive,
    warningCount: warnings,
    attentionCount: attentions,
    description,
  };
}

// =========================================================================
// Behavioral suggestions (template-driven)
// =========================================================================

export interface BehavioralSuggestion {
  category: string;
  suggestion: string;
  basedOn: string;
}

export function generateBehavioralSuggestions(
  hsi: HSIScore,
  alerts: UserAlert[],
  graphSummary?: GraphSummary,
): BehavioralSuggestion[] {
  const suggestions: BehavioralSuggestion[] = [];

  if (hsi.behavioralConsistency < 50) {
    const adherenceAlert = alerts.find((a) => a.ruleType === "adherence_decline");
    if (adherenceAlert) {
      suggestions.push({
        category: "medication",
        suggestion: "Your medication consistency has changed recently. Logging medication events can help you and your doctor understand your health trajectory better.",
        basedOn: "Medication adherence scoring",
      });
    }
  }

  if (graphSummary) {
    const sleepEdge = graphSummary.strongestEdges.find(
      (e) =>
        (e.sourceConcept?.includes("sleep") && e.relation === "temporal_sequence") ||
        (e.targetConcept?.includes("sleep") && e.relation === "temporal_sequence"),
    );
    if (sleepEdge) {
      suggestions.push({
        category: "sleep",
        suggestion: "Your recent health patterns suggest sleep consistency may be a factor worth tracking more carefully.",
        basedOn: "Health graph analysis — sleep-symptom correlation",
      });
    }

    const stressEdge = graphSummary.strongestEdges.find(
      (e) => e.sourceConcept?.includes("stress") || e.targetConcept?.includes("stress"),
    );
    if (stressEdge) {
      suggestions.push({
        category: "stress",
        suggestion: "Stress-related patterns have been observed in your health data. Consider tracking stress levels alongside symptoms.",
        basedOn: "Health graph analysis — stress correlation",
      });
    }
  }

  const gapAlert = alerts.find((a) => a.ruleType === "logging_gap");
  if (gapAlert) {
    suggestions.push({
      category: "engagement",
      suggestion: "Regular health logging improves the accuracy of your Health Stability Index. Even brief daily entries make a difference.",
      basedOn: "Logging gap detection",
    });
  }

  const escalationAlert = alerts.find((a) => a.ruleType === "symptom_escalation");
  if (escalationAlert) {
    suggestions.push({
      category: "monitoring",
      suggestion: "A symptom shows an increasing trend. Tracking this symptom with consistent intensity ratings will help identify whether the pattern continues.",
      basedOn: "Symptom escalation detection",
    });
  }

  return suggestions;
}
