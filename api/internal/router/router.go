// Package router is the one place that says which checks guard which
// routes. Reading this file should answer "who can do what" without
// opening a handler.
package router

import (
	"errors"
	"time"

	"github.com/gofiber/fiber/v2"

	"github.com/onuragtas/revify/internal/handler"
	"github.com/onuragtas/revify/internal/middleware"
	"github.com/onuragtas/revify/internal/repository"
	"github.com/onuragtas/revify/internal/service"
)

// BuildInfo travels from the linker to /api/health, so "which build is
// answering?" has an answer that does not depend on reading a log.
type BuildInfo struct {
	Number string
	Commit string
}

// New wires the layers together and returns the Fiber app.
func New(repo *repository.Repository, sessionTTL time.Duration, build BuildInfo) *fiber.App {
	authSvc := service.NewAuth(repo, sessionTTL)
	teamSvc := service.NewTeam(repo)
	assignSvc := service.NewAssignment(repo, teamSvc)
	settingsSvc := service.NewSettings(repo)
	decisionSvc := service.NewDecision(repo)
	nudgeSvc := service.NewNudge(repo, teamSvc)

	authH := handler.NewAuth(authSvc)
	teamH := handler.NewTeam(teamSvc)
	assignH := handler.NewAssignment(assignSvc)
	settingsH := handler.NewSettings(settingsSvc)
	decisionH := handler.NewDecision(decisionSvc)
	nudgeH := handler.NewNudge(nudgeSvc)

	app := fiber.New(fiber.Config{
		// One error shape for the whole API, including the failures Fiber
		// raises itself (404, 405, body too large) — a client should not
		// have to parse two different formats.
		ErrorHandler: func(c *fiber.Ctx, err error) error {
			code := fiber.StatusInternalServerError
			var fe *fiber.Error
			if errors.As(err, &fe) {
				code = fe.Code
			}
			return c.Status(code).JSON(fiber.Map{"error": err.Error()})
		},
		BodyLimit:             1 << 20,
		ReadTimeout:           10 * time.Second,
		AppName:               "Revify API",
		DisableStartupMessage: true,
	})

	requireUser := middleware.RequireUser(authSvc)
	requireMember := middleware.RequireMember(teamSvc)

	api := app.Group("/api")
	api.Get("/health", func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{"ok": true, "build": build.Number, "commit": build.Commit})
	})

	// Credential guessing is throttled per IP. Registration too: it is the
	// other endpoint that creates state from an unauthenticated request.
	loginLimit := middleware.NewLoginLimiter(10, time.Minute).Handler()

	auth := api.Group("/auth")
	auth.Post("/register", loginLimit, authH.Register)
	auth.Post("/login", loginLimit, authH.Login)
	auth.Post("/logout", authH.Logout)
	auth.Get("/me", authH.Me)

	// Everything below needs a session.
	api.Get("/users", requireUser, teamH.SearchUsers)
	api.Get("/assignments/mine", requireUser, assignH.Mine)
	// Not team-scoped: you poll for everything anyone has asked you to
	// look at, across every team you are on.
	api.Get("/nudges/mine", requireUser, nudgeH.Mine)

	teams := api.Group("/teams", requireUser)
	teams.Get("/", teamH.List)
	teams.Post("/", teamH.Create)

	// And everything below needs membership of the team in the path.
	team := teams.Group("/:teamID", requireMember)
	team.Get("/members", teamH.Members)
	team.Post("/members", middleware.RequireOwner("üyesini eklemek"), teamH.AddMember)
	team.Delete("/members/:userID", middleware.RequireOwner("üyesini çıkarmak"), teamH.RemoveMember)
	team.Get("/assignments", assignH.ForTeam)
	team.Post("/assignments", assignH.Assign)
	team.Post("/assignments/:issueKey/close", assignH.Close)

	// Team-wide review policy and notes: everyone reads, only the owner
	// writes. A JQL or a status name changed by mistake reshapes the whole
	// team's queue, which is the same reason membership is owner-managed.
	team.Get("/settings", settingsH.Get)
	team.Put("/settings", middleware.RequireOwner("ayarlarını değiştirmek"), settingsH.Save)
	// Notes are not policy, though they read like it. A note is what one
	// reviewer learned while reading this repo — "the retry here is
	// deliberate, stop flagging it" — and the person who learns it is
	// whoever happened to review that issue. Requiring the owner to relay
	// it is how a team keeps re-learning the same thing.
	//
	// Deleting your own is always allowed; someone else's needs the owner,
	// because removing a standing rule silently changes every future
	// review. That distinction is made in the service — see DeleteNote.
	team.Get("/notes", settingsH.Notes)
	team.Post("/notes", settingsH.AddNote)
	// Not owner-gated at the route: who may delete depends on *which* note
	// it is — your own or someone else's — and the route cannot see that.
	team.Delete("/notes/:noteID", settingsH.DeleteNote)

	// Where reviews landed. Any member may record one — the decision has
	// already reached Jira by the time this is called, so refusing it here
	// would only lose the record, not prevent the change.
	team.Get("/decisions", decisionH.ForTeam)
	team.Post("/decisions", decisionH.Record)

	// "Bu işe bakar mısın." Any member may send one; the target must be on
	// the team, which is what keeps this from being a way to put a
	// notification on any account.
	team.Post("/assignments/:issueKey/nudge", nudgeH.Send)
	team.Get("/assignments/:issueKey/nudges", nudgeH.ForIssue)

	return app
}
