package handler

import (
	"github.com/gofiber/fiber/v2"

	"github.com/onuragtas/revify/internal/middleware"
	"github.com/onuragtas/revify/internal/model"
	"github.com/onuragtas/revify/internal/service"
)

type Settings struct{ settings *service.Settings }

func NewSettings(settings *service.Settings) *Settings { return &Settings{settings: settings} }

func (h *Settings) Get(c *fiber.Ctx) error {
	settings, err := h.settings.Get(c.Params("teamID"))
	if err != nil {
		return Fail(c, err)
	}
	// The caller's role travels with the settings so a client can render
	// them read-only without a second request to find out who it is.
	return c.JSON(fiber.Map{"settings": settings, "role": c.Locals("role")})
}

func (h *Settings) Save(c *fiber.Ctx) error {
	var body model.TeamSettings
	if err := c.BodyParser(&body); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Geçersiz istek."})
	}

	settings, err := h.settings.Save(c.Params("teamID"), middleware.CurrentUser(c).ID, body)
	if err != nil {
		return Fail(c, err)
	}
	return c.JSON(fiber.Map{"settings": settings})
}

func (h *Settings) Notes(c *fiber.Ctx) error {
	notes, err := h.settings.Notes(c.Params("teamID"))
	if err != nil {
		return Fail(c, err)
	}
	return List(c, notes)
}

func (h *Settings) AddNote(c *fiber.Ctx) error {
	var body model.TeamNote
	if err := c.BodyParser(&body); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Geçersiz istek."})
	}

	note, err := h.settings.AddNote(c.Params("teamID"), middleware.CurrentUser(c).ID, body)
	if err != nil {
		return Fail(c, err)
	}
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"note": note})
}

func (h *Settings) DeleteNote(c *fiber.Ctx) error {
	role, _ := c.Locals("role").(string)
	if err := h.settings.DeleteNote(
		c.Params("teamID"), c.Params("noteID"), middleware.CurrentUser(c).ID, role,
	); err != nil {
		return Fail(c, err)
	}
	return c.JSON(fiber.Map{"ok": true})
}
