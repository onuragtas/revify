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

	authH := handler.NewAuth(authSvc)
	teamH := handler.NewTeam(teamSvc)
	assignH := handler.NewAssignment(assignSvc)
	settingsH := handler.NewSettings(settingsSvc)

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
	team.Get("/notes", settingsH.Notes)
	team.Post("/notes", middleware.RequireOwner("notu eklemek"), settingsH.AddNote)
	team.Delete("/notes/:noteID", middleware.RequireOwner("notu silmek"), settingsH.DeleteNote)

	return app
}
