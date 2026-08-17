package service

import (
	"strings"
	"time"

	"github.com/onuragtas/revify/internal/model"
	"github.com/onuragtas/revify/internal/repository"
)

type Assignment struct {
	repo *repository.Repository
	team *Team
}

func NewAssignment(repo *repository.Repository, team *Team) *Assignment {
	return &Assignment{repo: repo, team: team}
}

type AssignInput struct {
	TeamID     string
	IssueKey   string
	AssigneeID string
	AssignedBy string
	Note       string
	// What the assigner knew at the time. Never the review text: that is
	// the assignee's to produce, not ours to hand over.
	Summary string
}

func (a *Assignment) Assign(in AssignInput) error {
	in.IssueKey = strings.TrimSpace(in.IssueKey)
	in.AssigneeID = strings.TrimSpace(in.AssigneeID)
	if in.IssueKey == "" || in.AssigneeID == "" {
		return fail(KindInvalid, "issueKey ve assigneeId gerekli.")
	}
	// You can only hand work to someone on the team — otherwise this would
	// let anyone push work onto any account.
	if _, member := a.team.Role(in.TeamID, in.AssigneeID); !member {
		return fail(KindInvalid, "Atanan kişi bu takımın üyesi değil.")
	}

	err := a.repo.UpsertAssignment(model.Assignment{
		TeamID: in.TeamID, IssueKey: in.IssueKey, AssigneeID: in.AssigneeID,
		AssignedBy: in.AssignedBy, Note: strings.TrimSpace(in.Note),
		Summary: strings.TrimSpace(in.Summary), Status: model.StatusOpen,
		AssignedAt: time.Now().UTC(),
	})
	if err != nil {
		return wrap(err, "Atama yapılamadı.")
	}
	return nil
}

func (a *Assignment) ForUser(userID string) ([]model.AssignmentView, error) {
	items, err := a.repo.AssignmentsForUser(userID)
	if err != nil {
		return nil, wrap(err, "Atamalar okunamadı.")
	}
	return items, nil
}

func (a *Assignment) ForTeam(teamID string) ([]model.AssignmentView, error) {
	items, err := a.repo.AssignmentsForTeam(teamID)
	if err != nil {
		return nil, wrap(err, "Atamalar okunamadı.")
	}
	return items, nil
}

// Close marks it done. Either party may: the assignee because they
// finished, the assigner because it stopped mattering.
func (a *Assignment) Close(teamID, issueKey string) error {
	found, err := a.repo.CloseAssignment(teamID, issueKey)
	if err != nil {
		return wrap(err, "Atama kapatılamadı.")
	}
	if !found {
		return fail(KindNotFound, "Böyle bir atama yok.")
	}
	return nil
}
