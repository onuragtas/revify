package handler

import (
	"github.com/gofiber/fiber/v2"

	"github.com/onuragtas/revify/internal/middleware"
	"github.com/onuragtas/revify/internal/service"
)

type Decision struct{ decisions *service.Decision }

func NewDecision(decisions *service.Decision) *Decision { return &Decision{decisions: decisions} }

// ForTeam is the "Kararlar" list: what the team approved and what it sent
// back, newest first.
func (h *Decision) ForTeam(c *fiber.Ctx) error {
	items, err := h.decisions.ForTeam(c.Params("teamID"))
	if err != nil {
		return Fail(c, err)
	}
	return List(c, items)
}

// Record is called by a reviewer's own app once a decision has actually
// reached Jira — never before. Publishing an intention would leave the team
// reading outcomes that did not happen.
func (h *Decision) Record(c *fiber.Ctx) error {
	var body struct{ IssueKey, Decision, Severity, Summary, Note string }
	if err := c.BodyParser(&body); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Geçersiz istek."})
	}

	decision, err := h.decisions.Record(service.DecisionInput{
		TeamID:    c.Params("teamID"),
		IssueKey:  body.IssueKey,
		Decision:  body.Decision,
		Severity:  body.Severity,
		Summary:   body.Summary,
		Note:      body.Note,
		DecidedBy: middleware.CurrentUser(c).ID,
	})
	if err != nil {
		return Fail(c, err)
	}
	return c.JSON(fiber.Map{"decision": decision})
}
