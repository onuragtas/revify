package handler

import (
	"github.com/gofiber/fiber/v2"

	"github.com/onuragtas/revify/internal/middleware"
	"github.com/onuragtas/revify/internal/service"
)

type Team struct{ team *service.Team }

func NewTeam(team *service.Team) *Team { return &Team{team: team} }

// SearchUsers is how a team gets built: look someone up, then add them by
// id. Requiring an exact email would mean knowing it by heart.
func (h *Team) SearchUsers(c *fiber.Ctx) error {
	users, err := h.team.SearchUsers(c.Query("q"))
	if err != nil {
		return Fail(c, err)
	}
	return List(c, users)
}

func (h *Team) List(c *fiber.Ctx) error {
	teams, err := h.team.ForUser(middleware.CurrentUser(c).ID)
	if err != nil {
		return Fail(c, err)
	}
	return List(c, teams)
}

func (h *Team) Create(c *fiber.Ctx) error {
	var body struct{ Name string }
	if err := c.BodyParser(&body); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Takım adı gerekli."})
	}

	team, err := h.team.Create(body.Name, middleware.CurrentUser(c).ID)
	if err != nil {
		return Fail(c, err)
	}
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"team": team})
}

func (h *Team) Members(c *fiber.Ctx) error {
	members, err := h.team.Members(c.Params("teamID"))
	if err != nil {
		return Fail(c, err)
	}
	return List(c, members)
}

func (h *Team) AddMember(c *fiber.Ctx) error {
	var body struct{ UserID string }
	if err := c.BodyParser(&body); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Geçersiz istek."})
	}

	member, err := h.team.AddMember(c.Params("teamID"), body.UserID)
	if err != nil {
		return Fail(c, err)
	}
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"member": member})
}

func (h *Team) RemoveMember(c *fiber.Ctx) error {
	err := h.team.RemoveMember(c.Params("teamID"), c.Params("userID"), middleware.CurrentUser(c).ID)
	if err != nil {
		return Fail(c, err)
	}
	return c.JSON(fiber.Map{"ok": true})
}
