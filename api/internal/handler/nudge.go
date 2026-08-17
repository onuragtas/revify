package handler

import (
	"time"

	"github.com/gofiber/fiber/v2"

	"github.com/onuragtas/revify/internal/middleware"
	"github.com/onuragtas/revify/internal/service"
)

type Nudge struct{ nudges *service.Nudge }

func NewNudge(nudges *service.Nudge) *Nudge { return &Nudge{nudges: nudges} }

// Send asks a team-mate to look at an issue.
func (h *Nudge) Send(c *fiber.Ctx) error {
	var body struct{ ToUserID, Message string }
	if err := c.BodyParser(&body); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Geçersiz istek."})
	}

	nudge, err := h.nudges.Send(service.NudgeInput{
		TeamID:     c.Params("teamID"),
		IssueKey:   c.Params("issueKey"),
		ToUserID:   body.ToUserID,
		FromUserID: middleware.CurrentUser(c).ID,
		Message:    body.Message,
	})
	if err != nil {
		return Fail(c, err)
	}
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"nudge": nudge})
}

// Mine is what a reviewer's own app polls.
//
// `since` is the caller's high-water mark, not a server-side "seen" flag:
// each machine announces a nudge once and then asks only for newer ones.
// Keeping that state on the client means two machines both tell you, which
// is the behaviour you want from a reminder.
func (h *Nudge) Mine(c *fiber.Ctx) error {
	since := time.Time{}
	if raw := c.Query("since"); raw != "" {
		if parsed, err := time.Parse(time.RFC3339, raw); err == nil {
			since = parsed
		}
	}

	items, err := h.nudges.ForUser(middleware.CurrentUser(c).ID, since)
	if err != nil {
		return Fail(c, err)
	}
	return List(c, items)
}

// ForIssue is what the sender sees: asking twice should look like asking
// twice, so nobody nudges into silence without noticing.
func (h *Nudge) ForIssue(c *fiber.Ctx) error {
	items, err := h.nudges.ForIssue(c.Params("teamID"), c.Params("issueKey"))
	if err != nil {
		return Fail(c, err)
	}
	return List(c, items)
}
