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
The front's «Escanear» opens the phone's native camera (`<input capture="environment">`) and uploads the photo
reduced to 1600 px; the old in-browser live scanner (`src/utils/plate-scan.ts`, which uploaded only the part of the
frame visible in its 3:4 viewer) is no longer opened. The ALPR service detects in the central square around
the guide and in the whole image, so a plate the operator aims at is found even with poor phone cameras. See
`alpr/README.md`.

### Vehicle type and model

`POST /plate-recognition/vehicle-type` (`TipoVehiculoService`) receives the photo that produced the plate read and
suggests the vehicle type and model with Gemini (same `GEMINI_API_KEY`/models as the assistant), in both modalities.
The plate is always read by the playa's plate engine (Plate Recognizer or the platform ALPR), never by Gemini. The
response is constrained by schema to the playa's enabled type codes or `NINGUNO`, plus `modelo` (make and model as known
in Argentina, sanitized to 60 chars). Any failure (no key, quota, invalid answer) returns nulls and never blocks the
entry. The photo is sent to Google only for that request and is not stored. When a scanned plate is not inside, the
dock scanner starts the detection while the operator answers «¿Está entrando o se está yendo?», and the entry dialog
reuses that result. The dialog preselects the type only if the operator didn't change it and no frequent customer set
it meanwhile, and fills `modeloVehiculo` only when it is empty.
