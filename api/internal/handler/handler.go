// Package handler is the HTTP layer: parse the request, call a service,
// turn the answer into a response. It holds no rules of its own.
//
// The one thing it owns outright is the mapping from a service failure to a
// status code — in exactly one place, so a rule never has to carry an HTTP
// concern around with it.
package handler

import (
	"github.com/gofiber/fiber/v2"

	"github.com/onuragtas/revify/internal/service"
)

// statusFor is the whole reason the service layer can stay ignorant of HTTP.
func statusFor(kind service.Kind) int {
	switch kind {
	case service.KindInvalid:
		return fiber.StatusBadRequest
	case service.KindUnauthorized:
		return fiber.StatusUnauthorized
	case service.KindForbidden:
		return fiber.StatusForbidden
	case service.KindNotFound:
		return fiber.StatusNotFound
	case service.KindConflict:
		return fiber.StatusConflict
	default:
		return fiber.StatusInternalServerError
	}
}

// Fail renders a service error. Internal failures are logged with their
// cause but reported without it: a client has no use for a SQL error, and
// echoing one back is how implementation details leak.
func Fail(c *fiber.Ctx, err error) error {
	kind, message := service.KindOf(err)
	if kind == service.KindInternal {
		c.Context().Logger().Printf("internal error: %v", err)
	}
	return c.Status(statusFor(kind)).JSON(fiber.Map{"error": message})
}

func List(c *fiber.Ctx, items any) error { return c.JSON(fiber.Map{"items": items}) }
