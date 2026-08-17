package service

import (
	"errors"
	"strings"
	"time"

	"gorm.io/gorm"

	"github.com/onuragtas/revify/internal/model"
	"github.com/onuragtas/revify/internal/repository"
)

// Search results are capped, and a query is required. Together they mean
// this endpoint answers "who is this person" without also answering "list everyone
// who works here" — a directory dump is a different thing to hand out than
// a lookup.
const (
	searchMinLength = 2
	searchLimit     = 20
)

type Team struct{ repo *repository.Repository }

func NewTeam(repo *repository.Repository) *Team { return &Team{repo: repo} }

// SearchUsers is how a team gets built: you look someone up, then add them
// by id. Matching on an exact email would mean knowing it by heart.
func (t *Team) SearchUsers(query string) ([]model.Member, error) {
	query = strings.TrimSpace(query)
	if len(query) < searchMinLength {
		return nil, fail(KindInvalid, "En az 2 karakter yaz.")
	}
	users, err := t.repo.SearchUsers(query, searchLimit)
	if err != nil {
		return nil, wrap(err, "Kullanıcılar aranamadı.")
	}
	return users, nil
}

func (t *Team) Create(name, ownerID string) (model.TeamView, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return model.TeamView{}, fail(KindInvalid, "Takım adı gerekli.")
	}

	team := model.Team{ID: NewID(), Name: name, CreatedBy: ownerID, CreatedAt: time.Now().UTC()}
	if err := t.repo.CreateTeam(team, ownerID); err != nil {
		return model.TeamView{}, wrap(err, "Takım oluşturulamadı.")
	}
	return model.TeamView{ID: team.ID, Name: team.Name, Role: model.RoleOwner}, nil
}

func (t *Team) ForUser(userID string) ([]model.TeamView, error) {
	teams, err := t.repo.TeamsForUser(userID)
	if err != nil {
		return nil, wrap(err, "Takımlar okunamadı.")
	}
	return teams, nil
}

// Role is the authorisation primitive the middleware leans on: membership,
// not merely being logged in, is what grants access to anything
// team-scoped.
func (t *Team) Role(teamID, userID string) (string, bool) {
	member, err := t.repo.Member(teamID, userID)
	if err != nil {
		return "", false
	}
	return member.Role, true
}

func (t *Team) Members(teamID string) ([]model.Member, error) {
	members, err := t.repo.Members(teamID)
	if err != nil {
		return nil, wrap(err, "Üyeler okunamadı.")
	}
	return members, nil
}

func (t *Team) AddMember(teamID, userID string) (model.Member, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return model.Member{}, fail(KindInvalid, "Kullanıcı seçilmedi.")
	}

	user, err := t.repo.UserByID(userID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.Member{}, fail(KindNotFound, "Böyle bir kullanıcı yok.")
	} else if err != nil {
		return model.Member{}, wrap(err, "Kullanıcı aranamadı.")
	}

	joined := time.Now().UTC()
	if err := t.repo.AddMember(model.TeamMember{
		TeamID: teamID, UserID: user.ID, Role: model.RoleMember, JoinedAt: joined,
	}); err != nil {
		return model.Member{}, wrap(err, "Üye eklenemedi.")
	}
	return model.Member{ID: user.ID, Email: user.Email, Name: user.Name, Role: model.RoleMember, JoinedAt: joined}, nil
}

func (t *Team) RemoveMember(teamID, userID, callerID string) error {
	if userID == callerID {
		// A team without its owner would be unmanageable.
		return fail(KindInvalid, "Takım sahibi kendini çıkaramaz.")
	}
	if err := t.repo.RemoveMember(teamID, userID); err != nil {
		return wrap(err, "Üye çıkarılamadı.")
	}
	return nil
}
