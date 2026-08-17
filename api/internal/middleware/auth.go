// Package middleware carries the checks that must not be forgotten.
//
// They are middleware rather than a first line in each handler for exactly
// that reason: a handler can forget to call a function, but it cannot
// forget the middleware its route group is mounted behind.
package middleware

import (
	"github.com/gofiber/fiber/v2"

	"github.com/onuragtas/revify/internal/model"
	"github.com/onuragtas/revify/internal/service"
)

const (
	SessionCookie = "ar_session"
	userKey       = "user"
	roleKey       = "role"
)

// RequireUser rejects anonymous callers and stashes the caller.
func RequireUser(auth *service.Auth) fiber.Handler {
	return func(c *fiber.Ctx) error {
		user, ok := auth.UserForToken(c.Cookies(SessionCookie))
		if !ok {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "Giriş yapmalısın."})
		}
		c.Locals(userKey, user)
		return c.Next()
	}
}

// RequireMember is the authorisation boundary for everything team-scoped:
// being logged in says nothing about which teams you may look at. It also
// stashes the role, so the handlers that care about ownership do not look
// it up a second time.
func RequireMember(team *service.Team) fiber.Handler {
	return func(c *fiber.Ctx) error {
		role, ok := team.Role(c.Params("teamID"), CurrentUser(c).ID)
		if !ok {
			return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "Bu takımın üyesi değilsin."})
		}
		c.Locals(roleKey, role)
		return c.Next()
	}
}

// RequireOwner guards what only an owner may do. `action` completes the
// sentence, so the refusal says which thing was refused rather than a
// generic "forbidden".
func RequireOwner(action string) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if c.Locals(roleKey) != model.RoleOwner {
			return c.Status(fiber.StatusForbidden).
				JSON(fiber.Map{"error": "Takımın " + action + " için sahibi olmalısın."})
		}
		return c.Next()
	}
}

// CurrentUser is only valid behind RequireUser — which is the point: a
// route that forgets the middleware fails loudly here rather than quietly
// serving someone else's data.
func CurrentUser(c *fiber.Ctx) model.User { return c.Locals(userKey).(model.User) }
