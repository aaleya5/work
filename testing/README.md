# Manual / end-to-end testing

This project has no frontend, so "does it work" is verified by hitting the
HTTP API directly. Three options, from least to most setup:

## 1. Automated tests (no running server needed)

```bash
npm test                  # unit tests, Prisma mocked - fast, no DB
npm run test:integration  # spins up Postgres via Testcontainers + real HTTP
```

`test:integration` is the closest thing to "does the whole feature set
work" without manual steps - it seeds a course, enrolls a student, completes
lessons, and asserts the completion endpoint via `app.inject`.

## 2. `api.http` - interactive requests (VS Code / JetBrains)

Open `testing/api.http` with the VS Code "REST Client" extension (or
JetBrains' built-in HTTP client) and click "Send Request" on each block from
top to bottom. Tokens and ids from earlier responses are automatically
substituted into later requests via `{{name.response.body....}}`. Good for
poking at one endpoint at a time and inspecting the JSON response shape.
