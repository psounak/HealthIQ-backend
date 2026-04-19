/*
Maps Utility Contract (HealthIQ)
- Maps is NOT a medical authority.
- Maps does NOT imply urgency.
- Maps does NOT recommend providers.
- Maps is user-invoked only.

This module is pure utility:
- No AI calls.
- No health reasoning.
- No ranking, sorting, or "best" logic.
*/

export type LatLng = Readonly<{ lat: number; lng: number }>;

export type ProviderListing = Readonly<{
  // Raw listing fields returned to callers without ranking.
  name: string;
  address?: string;
  coordinates: LatLng;
  rating?: number;
  userRatingsTotal?: number;
  placeId?: string;

  // Keep the raw payload for audit/debug purposes (optional).
  raw?: unknown;
}>;

export type NearbySearchParams = Readonly<{
  specializationQuery: string;
  location: LatLng;
  radiusMeters?: number;
}>;

export type NearbySearchResult = Readonly<{
  // Returned in provider order from the upstream API.
  providers: readonly ProviderListing[];

  // Passthrough, useful for pagination and transparent downstream handling.
  nextPageToken?: string;

  // Raw upstream status (no interpretation here).
  status?: string;
  raw?: unknown;
}>;

function getGoogleMapsApiKey(): string {
  // NOTE: This reads from environment variables.
  // Loading `.env` into process.env is the responsibility of the runtime configuration.
  const key = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_API_KEY_PLACES || "";
  if (!key) {
    throw new Error(
      "Missing Google Maps API key. Set GOOGLE_MAPS_API_KEY in your environment (.env) before calling MapsClient.",
    );
  }
  return key;
}

function assertFiniteNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
}

function buildNearbySearchUrl(args: {
  apiKey: string;
  location: LatLng;
  radiusMeters: number;
  keyword: string;
  pageToken?: string;
}): string {
  const { apiKey, location, radiusMeters, keyword, pageToken } = args;

  const params = new URLSearchParams();
  params.set("key", apiKey);

  // Nearby Search requires `location` and either `radius` or `rankby=distance`.
  // We avoid `rankby=distance` because it is effectively ordering logic.
  params.set("location", `${location.lat},${location.lng}`);
  params.set("radius", String(radiusMeters));

  // The only query constraint we apply is the specialization keyword.
  // No additional filtering, no quality terms, no urgency terms.
  params.set("keyword", keyword);

  if (pageToken) params.set("pagetoken", pageToken);

  return `https://maps.googleapis.com/maps/api/place/nearbysearch/json?${params.toString()}`;
}

export async function nearbySearchProviders(params: NearbySearchParams & { pageToken?: string }): Promise<NearbySearchResult> {
  // Maps is opt-in and manual: callers must supply user-confirmed location explicitly.
  assertFiniteNumber(params.location.lat, "location.lat");
  assertFiniteNumber(params.location.lng, "location.lng");

  if (typeof params.specializationQuery !== "string" || !params.specializationQuery.trim()) {
    throw new Error("specializationQuery must be a non-empty string.");
  }

  const radiusMeters = params.radiusMeters ?? 8000; // Neutral default; not urgency-based.
  assertFiniteNumber(radiusMeters, "radiusMeters");

  const apiKey = getGoogleMapsApiKey();

  const url = buildNearbySearchUrl({
    apiKey,
    location: params.location,
    radiusMeters,
    keyword: params.specializationQuery.trim(),
    pageToken: params.pageToken,
  });

  // No SDK required: utility wrapper around the Places Nearby Search HTTP endpoint.
  if (typeof fetch !== "function") {
    throw new Error("Global fetch is not available. Provide a fetch polyfill in your runtime if needed.");
  }

  const resp = await fetch(url, { method: "GET" });
  if (!resp.ok) {
    throw new Error(`Google Maps request failed: HTTP ${resp.status}`);
  }

  const raw = (await resp.json()) as any;

  const results = Array.isArray(raw?.results) ? raw.results : [];

  // IMPORTANT: Do NOT sort or rank. Preserve upstream order.
  const providers: ProviderListing[] = results.map((r: any) => {
    const coordinates = {
      lat: Number(r?.geometry?.location?.lat),
      lng: Number(r?.geometry?.location?.lng),
    };

    return {
      name: String(r?.name ?? ""),
      address: typeof r?.vicinity === "string" ? r.vicinity : typeof r?.formatted_address === "string" ? r.formatted_address : undefined,
      coordinates,
      rating: typeof r?.rating === "number" ? r.rating : undefined,
      userRatingsTotal: typeof r?.user_ratings_total === "number" ? r.user_ratings_total : undefined,
      placeId: typeof r?.place_id === "string" ? r.place_id : undefined,
      raw: r,
    };
  });

  return {
    providers,
    nextPageToken: typeof raw?.next_page_token === "string" ? raw.next_page_token : undefined,
    status: typeof raw?.status === "string" ? raw.status : undefined,
    raw,
  };
}
