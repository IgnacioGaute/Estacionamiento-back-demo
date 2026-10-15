# Referencia técnica: patentes

### Plates

`src/tickets/utils/license-plate.util.ts` defines three stored columns per registration: `licensePlateOriginal`
(as typed, for display), `licensePlateNormalized` (uppercase alphanumeric, for active-duplicate detection),
`licensePlateSearch` (normalized + confusable folding O→0, I→1, S→5, B→8, for search). Always write all three
through `normalizePlate`/`toSearchKey`. Opening a second active registration for the same normalized plate is
rejected with code `DUPLICATE_ACTIVE_PLATE` unless the caller passes `duplicateOverride` + reason.
`noPlate: true` registrations require `lastNameCustomer` instead. `src/plate-recognition/` proxies the Plate
Recognizer ANPR API server-side so the key never reaches the browser; `image-signature.validator.ts` checks magic
bytes so a disguised document is rejected before anything parses it. There is **no platform key**: each playa
that buys the feature has its own Plate Recognizer account, whose token the super admin pastes in the empresa's
ficha (`PUT/DELETE /tenancy/playas/:id/patentes`, usage at `GET /tenancy/empresas/:id/patentes`). Tokens live
encrypted in `plate_recognizer_cuentas` (one row per playa, no TypeORM entity, operators get SELECT on their own
row only). With a playa token, requests use Plate Recognizer and each lookup consumes that plan.
Without a token, `alprConfigurado()` selects the platform ALPR when both `ALPR_URL` and `ALPR_TOKEN` exist.
Only when neither provider is available does the service return `PATENTES_SIN_PLAN`; tenant context also
accounts for configured ALPR before hiding the camera. ALPR failure does not silently use another playa's key.
The front's live scanner (`src/utils/plate-scan.ts`) filters frames before sending them. See `alpr/README.md`.
