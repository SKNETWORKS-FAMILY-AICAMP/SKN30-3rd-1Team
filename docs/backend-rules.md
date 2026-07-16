# Backend Engineering Rules

## Change discipline

- Keep changes within the active task scope.
- Prefer minimal, reversible changes.
- Preserve public API behavior unless the acceptance criteria explicitly require a contract change.
- Keep business logic out of transport or controller layers when the existing architecture supports separation.
- Preserve transaction boundaries and data consistency.
- Validate external input at the appropriate boundary.
- Never log credentials, access tokens, secrets, personal data, or complete sensitive payloads.
- Do not silently swallow exceptions.
- Match existing project conventions before introducing new patterns.

## Testing

- Add regression coverage for changed behavior.
- Cover failure paths and relevant boundary cases.
- Avoid tests that depend on execution order or mutable shared state.
- Mock external systems only at stable boundaries.
- A passing test suite does not override an unmet acceptance criterion.

## Frontend boundary

Frontend files are forbidden unless the user explicitly changes the workflow scope. Backend API compatibility risks must be documented in Korean reports under a `프론트엔드 영향` section.
