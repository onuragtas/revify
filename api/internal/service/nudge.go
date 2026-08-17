package service

import (
	"fmt"
	"strings"
	"time"

	"github.com/onuragtas/revify/internal/model"
	"github.com/onuragtas/revify/internal/repository"
)

// Nudge is one person asking another to look at something.
//
// The apps run on people's own machines, so nothing can be pushed to them:
// each one polls for what concerns it. A nudge is therefore a record here
// rather than a message sent anywhere — the assignee's app finds it on its
// next poll and says so.
//
// It exists next to the automatic reminders, not instead of them, because
// the two mean different things. A reminder says time passed. A nudge says
// a person is waiting, and that is worth interrupting someone for.
type Nudge struct {
	repo *repository.Repository
	team *Team
}

/** How long before the same person can be asked about the same issue
 * again. Long enough that a second click is a decision, short enough that
 * a genuinely urgent thing is not gated for the afternoon. */
const nudgeCooldown = 30 * time.Minute

func NewNudge(repo *repository.Repository, team *Team) *Nudge {
	return &Nudge{repo: repo, team: team}
}

type NudgeInput struct {
	TeamID     string
	IssueKey   string
	ToUserID   string
	FromUserID string
	Message    string
}

func (n *Nudge) Send(in NudgeInput) (model.Nudge, error) {
	in.IssueKey = strings.TrimSpace(in.IssueKey)
	in.ToUserID = strings.TrimSpace(in.ToUserID)
	if in.IssueKey == "" || in.ToUserID == "" {
		return model.Nudge{}, fail(KindInvalid, "issueKey ve kime gönderileceği gerekli.")
	}
	// Only within the team, for the same reason assignment is: otherwise
	// this endpoint would let anyone put a notification on any account.
	if _, member := n.team.Role(in.TeamID, in.ToUserID); !member {
		return model.Nudge{}, fail(KindInvalid, "Hatırlatılan kişi bu takımın üyesi değil.")
	}
	if in.ToUserID == in.FromUserID {
		return model.Nudge{}, fail(KindInvalid, "Kendine hatırlatma gönderemezsin.")
	}

	/*
	 * One every half hour, per issue, per person.
	 *
	 * Nothing stopped five in a row before. The recipient was spared by
	 * accident — their app polls every fifteen minutes and folds whatever
	 * it finds into one line — but that is a side effect of the interval,
	 * not a decision, and it would evaporate the moment polling got
	 * faster. Meanwhile the sender got no signal at all that they were
	 * repeating themselves.
	 *
	 * The refusal says when the last one went out, because "you already
	 * asked, eight minutes ago" answers the question the second click was
	 * really asking.
	 */
	if recent, err := n.repo.LastNudge(in.TeamID, in.IssueKey, in.ToUserID); err == nil {
		if since := time.Since(recent.CreatedAt); since < nudgeCooldown {
			return model.Nudge{}, fail(KindConflict, fmt.Sprintf(
				"Bu iş için %d dakika önce hatırlatma gönderildi. %d dakika sonra tekrar gönderebilirsin.",
				int(since.Minutes()), int((nudgeCooldown-since).Minutes())+1,
			))
		}
	}

	nudge := model.Nudge{
		ID: NewID(), TeamID: in.TeamID, IssueKey: in.IssueKey,
		ToUserID: in.ToUserID, FromUserID: in.FromUserID,
		Message: strings.TrimSpace(in.Message), CreatedAt: time.Now().UTC(),
	}
	if err := n.repo.CreateNudge(nudge); err != nil {
		return model.Nudge{}, wrap(err, "Hatırlatma gönderilemedi.")
	}
	return nudge, nil
}

// ForUser is what an app polls. `since` is the caller's own high-water
// mark: it announces each nudge once and then asks only for newer ones.
func (n *Nudge) ForUser(userID string, since time.Time) ([]model.NudgeView, error) {
	items, err := n.repo.NudgesForUser(userID, since)
	if err != nil {
		return nil, wrap(err, "Hatırlatmalar okunamadı.")
	}
	return items, nil
}

func (n *Nudge) ForIssue(teamID, issueKey string) ([]model.NudgeView, error) {
	items, err := n.repo.NudgesForIssue(teamID, issueKey)
	if err != nil {
		return nil, wrap(err, "Hatırlatmalar okunamadı.")
	}
	return items, nil
}
