package service

import (
	"strings"
	"time"

	"github.com/onuragtas/revify/internal/model"
	"github.com/onuragtas/revify/internal/repository"
)

// Decision is the team's record of what was approved and what was sent
// back.
//
// It lives here rather than on each machine because a decision is the one
// part of a review that is not private to the reviewer: it changed a Jira
// issue everyone can see. Kept locally, the record died with the laptop —
// nobody else could tell whether an issue had already been through review,
// and a reviewer who reinstalled lost the history of their own calls.
//
// What is stored is deliberately thin: the issue, the call, its severity
// and the title. Never the review text — that is written for the person who
// asked for it, and a team-wide archive of it is a different product with
// different consent.
type Decision struct{ repo *repository.Repository }

func NewDecision(repo *repository.Repository) *Decision { return &Decision{repo: repo} }

type DecisionInput struct {
	TeamID    string
	IssueKey  string
	Decision  string
	Severity  string
	Summary   string
	Note      string
	DecidedBy string
}

func (d *Decision) Record(in DecisionInput) (model.Decision, error) {
	in.IssueKey = strings.TrimSpace(in.IssueKey)
	in.Decision = strings.ToLower(strings.TrimSpace(in.Decision))
	if in.IssueKey == "" {
		return model.Decision{}, fail(KindInvalid, "issueKey gerekli.")
	}
	// Anything else is a client bug, and a bug that writes free text into a
	// column the UI filters on is one that quietly hides rows later.
	if in.Decision != model.DecisionApproved && in.Decision != model.DecisionRejected {
		return model.Decision{}, fail(KindInvalid, "Karar 'approved' veya 'rejected' olmalı.")
	}

	decision := model.Decision{
		TeamID: in.TeamID, IssueKey: in.IssueKey, Decision: in.Decision,
		Severity: strings.TrimSpace(in.Severity), Summary: strings.TrimSpace(in.Summary),
		Note: strings.TrimSpace(in.Note), DecidedBy: in.DecidedBy,
		DecidedAt: time.Now().UTC(),
	}
	// Upsert, not insert: an issue that comes back and is reviewed again has
	// one current outcome. Keeping every attempt would turn the list into a
	// log nobody reads to answer "where did this land?".
	if err := d.repo.RecordDecision(decision); err != nil {
		return model.Decision{}, wrap(err, "Karar kaydedilemedi.")
	}
	return decision, nil
}

func (d *Decision) ForTeam(teamID string) ([]model.DecisionView, error) {
	items, err := d.repo.DecisionsForTeam(teamID)
	if err != nil {
		return nil, wrap(err, "Kararlar okunamadı.")
	}
	return items, nil
}
