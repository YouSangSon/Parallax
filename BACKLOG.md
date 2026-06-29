# Backlog

Canonical detailed backlog: `IMPROVEMENT_OPPORTUNITIES.md`.

## Now

1. S1 residual changed-file scan/read reduction using the new scan-phase perf
   measurements and an adapter content-contract design.

## Later

1. JSON Schema / Avro deeper contract semantics: JSON Schema enum/format policy, Avro nested/named type resolution, aliases, promotions, and schema-registry integration.

## Done

1. W3 parse-only Nx project config discovery; Turborepo membership remains package-manager manifest based.
2. W3 deterministic npm/pnpm workspace package discovery.
3. W3 explicit package-directory workspace members share the root index in cross-repo resolution.
4. M9 repo-map hardening / dogfood.
5. D8 dependency PR dogfood lane.
6. D7 SARIF breadth.
7. D1 official PR action wrapper.
8. D6 pre-commit / pre-push impact-gate installer.
9. D4 deep-linkable UI/export.
10. M10 SCIP bridge: JSON import, CLI-backed binary ingest, and JSON export.
11. D9 affected verification planner from external affected-target research.
12. S4 measured perf baseline limits.
13. D2 contract-diff quality trend metric.
14. D2 co-change quality trend metric.
15. D2 trace-ingest promotion trend metric.
16. W4 OpenAPI response enum-removal compatibility detection.
17. W4 OpenAPI response format-change compatibility detection.
18. W4 OpenAPI response nullable-addition compatibility detection.
19. W4 OpenAPI request enum-value removal compatibility detection.
20. W4 OpenAPI request format-addition/change compatibility detection.
21. W4 OpenAPI response optional-property removal contract-diff visibility.
22. W5 JSON Schema contract-kind first slice.
23. W5 Avro contract-kind first slice.
24. S1 dirty/non-git no-changed-file adapter startup skip.
25. S1 `bench:perf` scan-phase timing split.
