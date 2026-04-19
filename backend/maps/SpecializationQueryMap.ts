/*
Maps Utility Contract (HealthIQ)
- Maps is NOT a medical authority.
- Maps does NOT imply urgency.
- Maps does NOT recommend providers.
- Maps is user-invoked only.

This file maps specializations (labels) to neutral search terms.
- No severity terms.
- No emergency terms.
- No qualitative ranking words.
*/

const MAP: Readonly<Record<string, string>> = {
  // Common specializations -> neutral search terms
  Cardiology: "cardiologist",
  Dermatology: "dermatologist",
  Endocrinology: "endocrinologist",
  Gastroenterology: "gastroenterologist",
  Neurology: "neurologist",
  Oncology: "oncologist",
  Ophthalmology: "ophthalmologist",
  Orthopedics: "orthopedic",
  Otolaryngology: "ENT specialist",
  Pediatrics: "pediatrician",
  Psychiatry: "psychiatrist",
  Psychology: "psychologist",
  Pulmonology: "pulmonologist",
  Rheumatology: "rheumatologist",
  Urology: "urologist",

  // Generalists
  "Primary Care": "primary care physician",
  "Family Medicine": "family doctor",
  "Internal Medicine": "internist",

  // Women/men's health (neutral)
  Gynecology: "gynecologist",
  Obstetrics: "obstetrician",

  // Therapy/rehab
  Physiotherapy: "physical therapist",
};

function normalizeKey(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

export function specializationToQueryTerm(specializationLabel: string): string {
  if (typeof specializationLabel !== "string" || !specializationLabel.trim()) {
    throw new Error("specializationLabel must be a non-empty string.");
  }

  const key = normalizeKey(specializationLabel);
  const mapped = MAP[key];
  if (mapped) return mapped;

  // Neutral fallback:
  // Use the label itself, lowercased; do not add urgency or quality words.
  return key.toLowerCase();
}

export function getSupportedSpecializationMappings(): Readonly<Record<string, string>> {
  // Exposed for transparency/debugging; callers must not treat this as a clinical taxonomy.
  return MAP;
}
