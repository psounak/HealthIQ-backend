// Visibility scopes are a first-class ethical boundary.
// They are intentionally explicit (no magic strings in calling code).

export enum VisibilityScope {
  UserOnly = "user-only",
  DoctorShareable = "doctor-shareable",
}
