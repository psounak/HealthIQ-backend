import type { AnyHealthEvent } from "../domain/HealthTimeline";
import type { SymptomEvent } from "../domain/SymptomEvent";
import type { MedicationEvent } from "../domain/MedicationEvent";
import type { LifestyleEvent } from "../domain/LifestyleEvent";
import type { ClinicalEvent } from "../domain/ClinicalEvent";
import { HealthEventType } from "../domain/HealthEvent";

// =========================================================================
// HealthIQ v2 — Concept Extractor
//
// Deterministic extraction of health concepts from timeline events.
// NO LLM involved — uses keyword matching, normalization, and pattern rules.
// Produces graph nodes from event data.
//
// Runs automatically on every event append.
// =========================================================================

export interface ExtractedConcept {
  concept: string;          // normalized label
  category: "symptom" | "medication" | "lifestyle" | "clinical";
  sourceEventId: string;
  timestamp: string;        // ISO
}

// --- Symptom normalization ---

const SYMPTOM_SYNONYMS: Record<string, string> = {
  "headache": "headache",
  "head pain": "headache",
  "migraine": "migraine",
  "head ache": "headache",
  "cephalgia": "headache",
  "nausea": "nausea",
  "feeling sick": "nausea",
  "queasy": "nausea",
  "vomiting": "vomiting",
  "throwing up": "vomiting",
  "fatigue": "fatigue",
  "tired": "fatigue",
  "exhaustion": "fatigue",
  "exhausted": "fatigue",
  "low energy": "fatigue",
  "insomnia": "insomnia",
  "trouble sleeping": "insomnia",
  "can't sleep": "insomnia",
  "difficulty sleeping": "insomnia",
  "back pain": "back_pain",
  "backache": "back_pain",
  "stomach pain": "stomach_pain",
  "abdominal pain": "stomach_pain",
  "belly pain": "stomach_pain",
  "chest pain": "chest_pain",
  "joint pain": "joint_pain",
  "arthralgia": "joint_pain",
  "dizziness": "dizziness",
  "dizzy": "dizziness",
  "lightheaded": "dizziness",
  "vertigo": "dizziness",
  "anxiety": "anxiety",
  "anxious": "anxiety",
  "worried": "anxiety",
  "depression": "depression",
  "depressed": "depression",
  "feeling down": "depression",
  "low mood": "depression",
  "cough": "cough",
  "coughing": "cough",
  "fever": "fever",
  "high temperature": "fever",
  "sore throat": "sore_throat",
  "throat pain": "sore_throat",
  "shortness of breath": "shortness_of_breath",
  "breathlessness": "shortness_of_breath",
  "difficulty breathing": "shortness_of_breath",
  "rash": "rash",
  "skin rash": "rash",
  "hives": "rash",
  "muscle pain": "muscle_pain",
  "myalgia": "muscle_pain",
  "constipation": "constipation",
  "diarrhea": "diarrhea",
  "bloating": "bloating",
  "swelling": "swelling",
  "palpitations": "palpitations",
  "heart racing": "palpitations",
  "weight gain": "weight_change",
  "weight loss": "weight_change",
};

// --- Lifestyle concept extraction ---

const LIFESTYLE_KEYWORDS: Record<string, string[]> = {
  "poor_sleep": ["poor sleep", "bad sleep", "didn't sleep", "insomnia", "restless", "woke up"],
  "good_sleep": ["good sleep", "slept well", "rested", "8 hours"],
  "high_stress": ["stressed", "high stress", "stressful", "anxious", "overwhelmed", "pressure"],
  "low_stress": ["relaxed", "calm", "no stress", "peaceful"],
  "exercise": ["exercise", "workout", "gym", "running", "walking", "yoga", "swimming"],
  "sedentary": ["sedentary", "no exercise", "inactive", "sat all day"],
  "healthy_eating": ["healthy food", "vegetables", "balanced", "fruits", "salad"],
  "unhealthy_eating": ["junk food", "fast food", "skipped meal", "sugar", "alcohol"],
};

function normalizeText(text: string): string {
  return text.toLowerCase().trim().replace(/[^a-z0-9\s'-]/g, "").replace(/\s+/g, " ");
}

function extractSymptomConcept(event: SymptomEvent): ExtractedConcept[] {
  const concepts: ExtractedConcept[] = [];
  const normalized = normalizeText(event.description);

  // Check against synonym map
  let matched = false;
  for (const [phrase, concept] of Object.entries(SYMPTOM_SYNONYMS)) {
    if (normalized.includes(phrase)) {
      concepts.push({
        concept,
        category: "symptom",
        sourceEventId: event.id,
        timestamp: event.timestamp.absolute,
      });
      matched = true;
    }
  }

  // If no match, use the normalized description itself as the concept
  if (!matched) {
    const shortDesc = normalized.split(" ").slice(0, 4).join("_");
    concepts.push({
      concept: shortDesc || "unclassified_symptom",
      category: "symptom",
      sourceEventId: event.id,
      timestamp: event.timestamp.absolute,
    });
  }

  return concepts;
}

function extractMedicationConcept(event: MedicationEvent): ExtractedConcept[] {
  const medName = normalizeText(event.name).replace(/\s+/g, "_");
  return [{
    concept: medName || "unknown_medication",
    category: "medication",
    sourceEventId: event.id,
    timestamp: event.timestamp.absolute,
  }];
}

function extractLifestyleConcept(event: LifestyleEvent): ExtractedConcept[] {
  const concepts: ExtractedConcept[] = [];
  const fields = [event.sleep, event.stress, event.activity, event.food].filter(Boolean);
  const combined = fields.join(" ");
  const normalized = normalizeText(combined);

  for (const [concept, keywords] of Object.entries(LIFESTYLE_KEYWORDS)) {
    if (keywords.some((kw) => normalized.includes(kw))) {
      concepts.push({
        concept,
        category: "lifestyle",
        sourceEventId: event.id,
        timestamp: event.timestamp.absolute,
      });
    }
  }

  // Default if no specific concept extracted
  if (concepts.length === 0 && combined.length > 0) {
    concepts.push({
      concept: "lifestyle_logged",
      category: "lifestyle",
      sourceEventId: event.id,
      timestamp: event.timestamp.absolute,
    });
  }

  return concepts;
}

function extractClinicalConcept(event: ClinicalEvent): ExtractedConcept[] {
  const concepts: ExtractedConcept[] = [];

  if (event.diagnosisLabel) {
    concepts.push({
      concept: normalizeText(event.diagnosisLabel).replace(/\s+/g, "_"),
      category: "clinical",
      sourceEventId: event.id,
      timestamp: event.timestamp.absolute,
    });
  }

  concepts.push({
    concept: "doctor_visit",
    category: "clinical",
    sourceEventId: event.id,
    timestamp: event.timestamp.absolute,
  });

  return concepts;
}

// =========================================================================
// Main extraction function
// =========================================================================

export function extractConcepts(event: AnyHealthEvent): ExtractedConcept[] {
  switch (event.eventType) {
    case HealthEventType.Symptom:
      return extractSymptomConcept(event as SymptomEvent);
    case HealthEventType.Medication:
      return extractMedicationConcept(event as MedicationEvent);
    case HealthEventType.Lifestyle:
      return extractLifestyleConcept(event as LifestyleEvent);
    case HealthEventType.Clinical:
      return extractClinicalConcept(event as ClinicalEvent);
    case HealthEventType.Insight:
      return []; // Insights don't create graph nodes
    default:
      return [];
  }
}

export function extractConceptsFromBatch(events: readonly AnyHealthEvent[]): ExtractedConcept[] {
  return events.flatMap(extractConcepts);
}
