# Backend Review Rules

Review in this priority order:

1. unmet acceptance criteria,
2. incorrect behavior and edge cases,
3. data corruption or partial state changes,
4. authentication, authorization, injection, and secret exposure,
5. regression risk,
6. error handling and recovery,
7. missing or ineffective tests,
8. maintainability problems with concrete change risk.

Do not report:

- personal style preferences,
- speculative architecture concerns without a failure mode,
- unrelated legacy issues outside the changed path,
- micro-optimizations without evidence,
- frontend fixes.

Severity guidance:

- Critical: exploitable security issue, severe data loss, or service-wide failure.
- High: likely production failure, incorrect core behavior, authorization bypass, or data inconsistency.
- Medium: conditional defect, meaningful regression risk, or important missing test.
- Low: limited-impact defect or maintainability issue with a concrete future risk.
