# Backend Validation Rules

Validation is acceptance-oriented, not an additional open-ended code review.

Required checks:

1. Every mandatory acceptance criterion has evidence.
2. Configured backend format, lint, type, test, and build checks pass or have an approved exception.
3. Every accepted Critical, High, and Medium review finding is resolved or explicitly blocked.
4. No finding triaged as `NEEDS_HUMAN` at Critical or High severity remains
   without a recorded human decision in `review-triage.md`.
5. Regression tests exercise the corrected behavior.
6. The diff does not include forbidden frontend paths. Verify with
   `scripts/check-scope.sh`, which also inspects untracked files. Do not rely
   on `git diff` alone: a newly created frontend file is invisible to it.
7. The verification run was not `INCONCLUSIVE`. If every check was skipped
   because no commands are configured, nothing was verified.
8. The final implementation remains within the approved plan or documents an approved deviation.
9. Remaining risks are listed clearly in Korean.

Return `BLOCKED` rather than guessing when validation depends on unavailable credentials, services, datasets, requirements, or runtime environments.

Return `BLOCKED`, never `PASS`, when an unresolved `NEEDS_HUMAN` finding of
Critical or High severity exists. Severity is judged from the review, not from
whether the implementer chose to act on it.
