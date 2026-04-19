import type { AnyHealthEvent } from "../domain/HealthTimeline";
import { extractConcepts, type ExtractedConcept } from "./ConceptExtractor";

// =========================================================================
// HealthIQ v2 — Health Graph Builder (Stateless)
//
// Builds a per-request directed graph of health concept relationships
// from the events the client sends. No server-side persistence.
//
// Nodes = health concepts (symptom, medication, lifestyle, clinical)
// Edges = relationships (co_occurrence, temporal_sequence, medication_response)
// =========================================================================

export type GraphRelation =
  | "co_occurrence"
  | "temporal_sequence"
  | "reported_trigger"
  | "medication_response";

export interface GraphNode {
  id: string;
  concept: string;
  category: string;
  occurrenceCount: number;
  firstSeen: string;
  lastSeen: string;
}

export interface GraphEdge {
  id: string;
  sourceNode: string;
  targetNode: string;
  sourceConcept?: string;
  targetConcept?: string;
  relation: GraphRelation;
  weight: number;
  firstObserved: string;
  lastObserved: string;
}

export interface GraphSummary {
  nodeCount: number;
  edgeCount: number;
  topConcepts: GraphNode[];
  strongestEdges: GraphEdge[];
}

const CO_OCCURRENCE_WINDOW_HOURS = 48;

// =========================================================================
// Build graph from a batch of events — purely functional, no side effects
// =========================================================================

export function buildGraphFromEvents(
  events: readonly AnyHealthEvent[],
  topN: number = 15,
): GraphSummary {
  // Node map: key = "concept|category"
  const nodeMap = new Map<string, {
    id: string;
    concept: string;
    category: string;
    occurrenceCount: number;
    firstSeen: string;
    lastSeen: string;
  }>();

  // Edge map: key = "sourceId|targetId|relation"
  const edgeMap = new Map<string, {
    id: string;
    sourceNodeId: string;
    targetNodeId: string;
    relation: GraphRelation;
    weight: number;
    firstObserved: string;
    lastObserved: string;
  }>();

  let nodeCounter = 0;
  let edgeCounter = 0;

  // Helper: upsert node
  function upsertNode(concept: ExtractedConcept): string {
    const key = `${concept.concept}|${concept.category}`;
    const existing = nodeMap.get(key);
    if (existing) {
      existing.occurrenceCount += 1;
      if (concept.timestamp > existing.lastSeen) existing.lastSeen = concept.timestamp;
      if (concept.timestamp < existing.firstSeen) existing.firstSeen = concept.timestamp;
      return existing.id;
    }
    const id = `node-${++nodeCounter}`;
    nodeMap.set(key, {
      id,
      concept: concept.concept,
      category: concept.category,
      occurrenceCount: 1,
      firstSeen: concept.timestamp,
      lastSeen: concept.timestamp,
    });
    return id;
  }

  // Helper: upsert edge
  function upsertEdge(
    sourceId: string,
    targetId: string,
    relation: GraphRelation,
    timestamp: string,
  ): void {
    if (sourceId === targetId) return;
    const key = `${sourceId}|${targetId}|${relation}`;
    const existing = edgeMap.get(key);
    if (existing) {
      existing.weight += 0.5;
      if (timestamp > existing.lastObserved) existing.lastObserved = timestamp;
      return;
    }
    edgeMap.set(key, {
      id: `edge-${++edgeCounter}`,
      sourceNodeId: sourceId,
      targetNodeId: targetId,
      relation,
      weight: 1.0,
      firstObserved: timestamp,
      lastObserved: timestamp,
    });
  }

  // Pre-extract concepts for all events
  const eventConcepts: { event: AnyHealthEvent; concepts: { concept: ExtractedConcept; nodeId: string }[] }[] = [];
  for (const event of events) {
    const concepts = extractConcepts(event);
    const mapped = concepts.map((c) => ({ concept: c, nodeId: upsertNode(c) }));
    eventConcepts.push({ event, concepts: mapped });
  }

  // Create edges from co-occurrences within the time window
  const windowMs = CO_OCCURRENCE_WINDOW_HOURS * 60 * 60 * 1000;

  for (let i = 0; i < eventConcepts.length; i++) {
    const current = eventConcepts[i];
    const currentTime = new Date(current.event.timestamp.absolute).getTime();

    for (let j = i + 1; j < eventConcepts.length; j++) {
      const other = eventConcepts[j];
      const otherTime = new Date(other.event.timestamp.absolute).getTime();

      if (Math.abs(currentTime - otherTime) > windowMs) continue;

      // Create edges between all concept pairs across the two events
      for (const cNode of current.concepts) {
        for (const oNode of other.concepts) {
          if (cNode.nodeId === oNode.nodeId) continue;

          let relation: GraphRelation = "co_occurrence";
          if (
            (cNode.concept.category === "medication" && oNode.concept.category === "symptom") ||
            (cNode.concept.category === "symptom" && oNode.concept.category === "medication")
          ) {
            relation = "medication_response";
          } else if (
            (cNode.concept.category === "lifestyle" && oNode.concept.category === "symptom") ||
            (cNode.concept.category === "symptom" && oNode.concept.category === "lifestyle")
          ) {
            relation = "temporal_sequence";
          }

          // Earlier event → later event for edge direction
          const sourceId = currentTime <= otherTime ? cNode.nodeId : oNode.nodeId;
          const targetId = currentTime <= otherTime ? oNode.nodeId : cNode.nodeId;

          upsertEdge(sourceId, targetId, relation, current.event.timestamp.absolute);
        }
      }
    }
  }

  // Build concept lookup
  const nodeIdToConcept = new Map<string, string>();
  for (const n of nodeMap.values()) nodeIdToConcept.set(n.id, n.concept);

  // Sort and slice
  const allNodes = Array.from(nodeMap.values());
  const allEdges = Array.from(edgeMap.values());

  const topConcepts = [...allNodes]
    .sort((a, b) => b.occurrenceCount - a.occurrenceCount)
    .slice(0, topN)
    .map((n) => ({
      id: n.id,
      concept: n.concept,
      category: n.category,
      occurrenceCount: n.occurrenceCount,
      firstSeen: n.firstSeen,
      lastSeen: n.lastSeen,
    }));

  const strongestEdges = [...allEdges]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, topN)
    .map((e) => ({
      id: e.id,
      sourceNode: e.sourceNodeId,
      targetNode: e.targetNodeId,
      sourceConcept: nodeIdToConcept.get(e.sourceNodeId),
      targetConcept: nodeIdToConcept.get(e.targetNodeId),
      relation: e.relation,
      weight: e.weight,
      firstObserved: e.firstObserved,
      lastObserved: e.lastObserved,
    }));

  return {
    nodeCount: allNodes.length,
    edgeCount: allEdges.length,
    topConcepts,
    strongestEdges,
  };
}
