package service

import (
	"errors"
	"strings"
	"time"

	"gorm.io/gorm"

	"github.com/onuragtas/revify/internal/model"
	"github.com/onuragtas/revify/internal/repository"
)

// Settings owns what a review means for a team: which issues count, where
// they go afterwards, what language the result is in, and the standing
// notes about what does not count as a problem here.
//
// Everything else — credentials, the model, and the switch that decides
// whether this machine writes to Jira at all — stays on each machine. The
// line is drawn at "would two people disagreeing about this be a bug?".
type Settings struct{ repo *repository.Repository }

func NewSettings(repo *repository.Repository) *Settings { return &Settings{repo: repo} }

// Defaults are returned rather than an error when a team has never saved:
// a team that has not configured itself yet is a normal state, and the
// client needs something coherent to render.
func (s *Settings) Get(teamID string) (model.TeamSettings, error) {
	settings, err := s.repo.TeamSettings(teamID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.TeamSettings{TeamID: teamID, Language: "English"}, nil
	}
	if err != nil {
		return model.TeamSettings{}, wrap(err, "Takım ayarları okunamadı.")
	}
	return settings, nil
}

func (s *Settings) Save(teamID, updatedBy string, in model.TeamSettings) (model.TeamSettings, error) {
	settings := model.TeamSettings{
		TeamID:        teamID,
		JQL:           strings.TrimSpace(in.JQL),
		ApproveStatus: strings.TrimSpace(in.ApproveStatus),
		RejectStatus:  strings.TrimSpace(in.RejectStatus),
		Language:      strings.TrimSpace(in.Language),
		UpdatedBy:     updatedBy,
		UpdatedAt:     time.Now().UTC(),
	}

	// A blank status name is worse than a wrong one: the app resolves
	// transitions by name at call time, so an empty one fails at the moment
	// someone approves, which is the worst moment to find out.
	if settings.JQL == "" {
		return model.TeamSettings{}, fail(KindInvalid, "JQL boş olamaz.")
	}
	if settings.ApproveStatus == "" || settings.RejectStatus == "" {
		return model.TeamSettings{}, fail(KindInvalid, "Onay ve red durum adları gerekli.")
	}
	if settings.Language == "" {
		settings.Language = "English"
	}

	if err := s.repo.SaveTeamSettings(settings); err != nil {
		return model.TeamSettings{}, wrap(err, "Takım ayarları kaydedilemedi.")
	}
	return settings, nil
}

func (s *Settings) Notes(teamID string) ([]model.TeamNote, error) {
	notes, err := s.repo.TeamNotes(teamID)
	if err != nil {
		return nil, wrap(err, "Notlar okunamadı.")
	}
	return notes, nil
}

func (s *Settings) AddNote(teamID, createdBy string, in model.TeamNote) (model.TeamNote, error) {
	note := model.TeamNote{
		ID:          NewID(),
		TeamID:      teamID,
		Scope:       strings.TrimSpace(in.Scope),
		ProjectPath: strings.TrimSpace(in.ProjectPath),
		Text:        strings.TrimSpace(in.Text),
		CreatedBy:   createdBy,
		CreatedAt:   time.Now().UTC(),
	}

	if note.Text == "" {
		return model.TeamNote{}, fail(KindInvalid, "Not metni gerekli.")
	}
	if note.Scope != model.ScopeRepo {
		note.Scope = model.ScopeGlobal
	}
	// A repo-scoped note with no repo would apply to nothing, silently.
	if note.Scope == model.ScopeRepo && note.ProjectPath == "" {
		return model.TeamNote{}, fail(KindInvalid, "Repo notu için proje yolu gerekli.")
	}
	if note.Scope == model.ScopeGlobal {
		note.ProjectPath = ""
	}

	if err := s.repo.CreateTeamNote(note); err != nil {
		return model.TeamNote{}, wrap(err, "Not eklenemedi.")
	}
	return note, nil
}

func (s *Settings) DeleteNote(teamID, noteID string) error {
	found, err := s.repo.DeleteTeamNote(teamID, noteID)
	if err != nil {
		return wrap(err, "Not silinemedi.")
	}
	if !found {
		return fail(KindNotFound, "Böyle bir not yok.")
	}
	return nil
}
