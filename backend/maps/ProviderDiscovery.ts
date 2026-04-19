/*
Maps Utility Contract (HealthIQ)
- Maps is NOT a medical authority.
- Maps does NOT imply urgency.
- Maps does NOT recommend providers.
- Maps is user-invoked only.

This orchestrator is intentionally thin and downstream of AI.
- No AI calls.
- No health reasoning.
- No ranking, scoring, or prioritization.
- No persistence.
*/

import type { MedicalSpecializationSuggestionDraft } from "../ai/SpecializationSuggester";
import type { LatLng, NearbySearchResult, ProviderListing } from "./MapsClient";
import { nearbySearchProviders } from "./MapsClient";
import { specializationToQueryTerm } from "./SpecializationQueryMap";

export type ProviderDiscoveryDisclaimer = Readonly<{
  notMedicalAdvice: true;
  notRanked: true;
  userDiscretionRequired: true;
}>;

export type ProvidersBySpecialization = Readonly<{
  specializationLabel: string;
  queryTerm: string;
  providers: readonly ProviderListing[];
  mapsStatus?: string;
  nextPageToken?: string;
}>;

export type ProviderDiscoveryResult = Readonly<{
  disclaimer: ProviderDiscoveryDisclaimer;
  location: LatLng;
  radiusMeters: number;

  // Grouped outputs; group order matches input order.
  groups: readonly ProvidersBySpecialization[];
}>;

// REVIEW-FIRST POLICY:
// - AI produced the specialization labels as a DRAFT.
// - Provider discovery MUST be user-invoked (manual) and MUST NOT auto-run from AI.
// - The user remains responsible for choosing whether and where to seek care.
export async function discoverProviders(args: {
  readonly specializationDraft: MedicalSpecializationSuggestionDraft;
  readonly userConfirmedLocation: LatLng;

  // Enforces explicit acknowledgment at call sites.
  readonly locationConfirmation: "user-confirmed";

  readonly radiusMeters?: number;
}): Promise<ProviderDiscoveryResult> {
  if (args.locationConfirmation !== "user-confirmed") {
    throw new Error("Provider discovery requires an explicit user-confirmed location.");
  }

  const radiusMeters = args.radiusMeters ?? 8000;

  const groups: ProvidersBySpecialization[] = [];

  for (const s of args.specializationDraft.result.specializations) {
    const specializationLabel = s.specialization;
    const queryTerm = specializationToQueryTerm(specializationLabel);

    // IMPORTANT:
    // - Do not sort.
    // - Do not rank.
    // - Do not filter beyond the queryTerm.
    const mapsResult: NearbySearchResult = await nearbySearchProviders({
      specializationQuery: queryTerm,
      location: args.userConfirmedLocation,
      radiusMeters,
    });

    groups.push({
      specializationLabel,
      queryTerm,
      providers: mapsResult.providers,
      mapsStatus: mapsResult.status,
      nextPageToken: mapsResult.nextPageToken,
    });
  }

  return {
    disclaimer: {
      notMedicalAdvice: true,
      notRanked: true,
      userDiscretionRequired: true,
    },
    location: args.userConfirmedLocation,
    radiusMeters,
    groups,
  };
}
