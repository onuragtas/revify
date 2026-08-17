package handler

import (
	"github.com/gofiber/fiber/v2"

	"github.com/onuragtas/revify/internal/middleware"
	"github.com/onuragtas/revify/internal/service"
)

type Assignment struct{ assignments *service.Assignment }

func NewAssignment(assignments *service.Assignment) *Assignment {
	return &Assignment{assignments: assignments}
}

// Mine is what a reviewer's own app polls to find what is waiting for them.
func (h *Assignment) Mine(c *fiber.Ctx) error {
	items, err := h.assignments.ForUser(middleware.CurrentUser(c).ID)
	if err != nil {
		return Fail(c, err)
	}
	return List(c, items)
}

func (h *Assignment) ForTeam(c *fiber.Ctx) error {
	items, err := h.assignments.ForTeam(c.Params("teamID"))
	if err != nil {
		return Fail(c, err)
	}
	return List(c, items)
}

func (h *Assignment) Assign(c *fiber.Ctx) error {
	var body struct{ IssueKey, AssigneeID, Note, Summary string }
	if err := c.BodyParser(&body); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Geçersiz istek."})
	}

	err := h.assignments.Assign(service.AssignInput{
		TeamID:     c.Params("teamID"),
		IssueKey:   body.IssueKey,
		AssigneeID: body.AssigneeID,
		AssignedBy: middleware.CurrentUser(c).ID,
		Note:       body.Note,
		Summary:    body.Summary,
	})
	if err != nil {
		return Fail(c, err)
	}
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"ok": true})
}

func (h *Assignment) Close(c *fiber.Ctx) error {
	if err := h.assignments.Close(c.Params("teamID"), c.Params("issueKey")); err != nil {
		return Fail(c, err)
	}
	return c.JSON(fiber.Map{"ok": true})
}
