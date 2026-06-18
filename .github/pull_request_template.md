## Summary

- 

## Verification

- [ ] `npm run verify`

If the full gate was not run, list the scoped commands you ran and why:

- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm run test:dogfood`
- [ ] `npm run bench`
- [ ] `npm run test:security`
- [ ] `npm run test:mcp`
- [ ] `npm run test:ui`
- [ ] `npm run test:install-smoke`
- [ ] `npm audit --audit-level=high`

## Safety

- [ ] No new MCP write capability
- [ ] File inputs stay inside repo root
- [ ] Evidence is redacted before output
- [ ] No local machine paths or secrets in docs
