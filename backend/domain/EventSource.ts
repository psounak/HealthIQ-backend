// Event sources describe where a HealthEvent originates.
// Keep this list small and meaningful; it is not a storage/import taxonomy.

export enum EventSource {
  User = "user",
  Prescription = "prescription",
  Device = "device",
  Doctor = "doctor",
}
