package handler

import (
	"time"

	"github.com/gofiber/fiber/v2"

	"github.com/onuragtas/revify/internal/middleware"
	"github.com/onuragtas/revify/internal/model"
	"github.com/onuragtas/revify/internal/service"
)

type Auth struct{ auth *service.Auth }

func NewAuth(auth *service.Auth) *Auth { return &Auth{auth: auth} }

func (h *Auth) Register(c *fiber.Ctx) error {
	var body struct{ Email, Name, Password string }
	if err := c.BodyParser(&body); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Geçersiz istek."})
	}

	user, session, err := h.auth.Register(body.Email, body.Name, body.Password)
	if err != nil {
		return Fail(c, err)
	}
	setSessionCookie(c, session)
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"user": user})
}

func (h *Auth) Login(c *fiber.Ctx) error {
	var body struct{ Email, Password string }
	if err := c.BodyParser(&body); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Geçersiz istek."})
	}

	user, session, err := h.auth.Login(body.Email, body.Password)
	if err != nil {
		return Fail(c, err)
	}
	setSessionCookie(c, session)
	return c.JSON(fiber.Map{"user": user})
}

func (h *Auth) Logout(c *fiber.Ctx) error {
	h.auth.Logout(c.Cookies(middleware.SessionCookie))
	c.Cookie(&fiber.Cookie{
		Name: middleware.SessionCookie, Value: "", Path: "/", HTTPOnly: true,
		Expires: time.Now().Add(-time.Hour),
	})
	return c.JSON(fiber.Map{"ok": true})
}

// Me answers for anonymous callers too — "nobody is logged in" is a state
// to render, not an error.
func (h *Auth) Me(c *fiber.Ctx) error {
	if user, ok := h.auth.UserForToken(c.Cookies(middleware.SessionCookie)); ok {
		return c.JSON(fiber.Map{"user": user})
	}
	return c.JSON(fiber.Map{"user": nil})
}

func setSessionCookie(c *fiber.Ctx, session model.Session) {
	// HttpOnly so page scripts cannot read it; SameSite=Lax so another site
	// cannot ride it on a cross-site POST.
	//
	// Secure is set whenever the request arrived over TLS — including
	// through a proxy that terminated it, which is how this is deployed. It
	// cannot be unconditional: on http://localhost the browser would drop
	// the cookie and nobody could sign in during development.
	c.Cookie(&fiber.Cookie{
		Name:     middleware.SessionCookie,
		Value:    session.Token,
		Path:     "/",
		HTTPOnly: true,
		Secure:   isTLS(c),
		SameSite: "Lax",
		Expires:  session.ExpiresAt,
	})
}

func isTLS(c *fiber.Ctx) bool {
	return c.Protocol() == "https" || c.Get("X-Forwarded-Proto") == "https"
}
