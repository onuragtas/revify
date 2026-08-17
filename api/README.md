# Revify API

The backend for Revify: a standalone Go service that coordinates **people**,
not reviews.

It knows who exists, who is on which team, and who owes whom a review. It
deliberately stores **no Jira or GitLab credentials and no review text** —
those stay on each reviewer's own machine. That boundary is why this can be
a shared service without becoming the one place worth breaking into.

Built and deployed by `Jenkinsfile` at the repository root, from this same
checkout. Only `build/` and local `*.db` files are untracked.

## Run

```bash
go test ./...                    # 16 tests, at the router level
go run ./cmd/api                 # :4322, ./api.db
API_ADDR=:8080 API_DB=/var/lib/revify/api.db go run ./cmd/api

CGO_ENABLED=0 go build -trimpath -o build/revify-api ./cmd/api   # static binary
```

`CGO_ENABLED=0` works because the SQLite driver is `glebarez/sqlite` (pure
Go) rather than `gorm.io/driver/sqlite` (cgo). One file to copy to a server.

## Endpoints

| Method | Path | Who |
|---|---|---|
| POST | `/api/auth/register` | anyone |
| POST | `/api/auth/login` | anyone |
| POST | `/api/auth/logout` | anyone |
| GET | `/api/auth/me` | anyone |
| GET/POST | `/api/teams/` | logged in |
| GET | `/api/teams/{id}/members` | member |
| GET | `/api/users?q=` | logged in |
| POST | `/api/teams/{id}/members` | owner |
| DELETE | `/api/teams/{id}/members/{userID}` | owner |
| GET | `/api/assignments/mine` | logged in |
| GET/POST | `/api/teams/{id}/assignments` | member |
| POST | `/api/teams/{id}/assignments/{issueKey}/close` | member |

## Layout

```
cmd/api/           entry point: config, wiring, signals
internal/
  config/          the environment, read once
  model/           what is stored and what is read back
  repository/      the only place that talks to the database
  service/         the rules — knows nothing about HTTP
  handler/         parse, call a service, render; owns status codes
  middleware/      the checks that must not be forgotten
  router/          which checks guard which routes
```

The split earns its keep at one seam in particular: services fail with a
typed `service.Kind`, and `handler.Fail` is the single place that turns a
kind into a status code. Without that, every rule would carry an HTTP
concern around with it and the layering would be filing, not design.

## Decisions worth knowing

- **Membership is the authorisation boundary.** Being logged in says nothing
  about which teams you may look at; `RequireMember` runs as Fiber
  middleware on the whole `/teams/:teamID` group so no handler can forget.
- **A team is built by searching, not by typing an address.** `/api/users`
  requires a query of at least two characters and caps results, so it
  answers "who is Esma" without also answering "list everyone who works
  here".
- **Login gives nothing away.** A wrong password and an unknown email return
  the same status and the same message, and the unknown-email path still
  runs a bcrypt comparison so the timing matches. Otherwise login becomes a
  way to enumerate who works here.
- **One reviewer per issue.** The composite primary key on `assignments`
  enforces it, so reassigning replaces the row instead of relying on handler
  code to clean up.
- **You can only assign to a team-mate.** Without that check the endpoint
  would let anyone push work onto any account.
- **Password hashes never leave the process.** `User.PasswordHash` is
  `json:"-"`, which is the difference between an API that returns users and
  one that leaks hashes.
- **bcrypt's 72-byte cap is enforced,** not ignored — silently truncating
  would make two different long passwords interchangeable.
