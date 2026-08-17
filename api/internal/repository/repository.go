// Package repository is the only place that talks to the database.
//
// It knows nothing about HTTP and nothing about rules: it stores and
// fetches. "Only an owner may add a member" and "you may not assign outside
// the team" live in the service layer, because those are decisions, not
// storage.
package repository

import (
	"time"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"gorm.io/gorm/logger"

	"github.com/onuragtas/revify/internal/model"
)

type Repository struct{ db *gorm.DB }

// Open connects and brings the schema up to date.
//
// The driver is glebarez/sqlite rather than gorm.io/driver/sqlite because
// the latter is cgo-bound: it needs a working C toolchain wherever this is
// built, and gives up the single static binary that makes a Go service
// worth deploying. This one is pure Go.
func Open(path string, log logger.Interface) (*Repository, error) {
	db, err := gorm.Open(sqlite.Open(path+"?_pragma=busy_timeout(5000)"), &gorm.Config{Logger: log})
	if err != nil {
		return nil, err
	}

	if err := db.AutoMigrate(
		&model.User{}, &model.Team{}, &model.TeamMember{}, &model.Session{}, &model.Assignment{},
		&model.TeamSettings{}, &model.TeamNote{}, &model.Decision{},
	); err != nil {
		return nil, err
	}

	// SQLite takes one writer at a time. Letting the pool open several
	// connections buys nothing and turns contention into SQLITE_BUSY.
	sqlDB, err := db.DB()
	if err != nil {
		return nil, err
	}
	sqlDB.SetMaxOpenConns(1)

	return &Repository{db: db}, nil
}

func (r *Repository) Close() error {
	sqlDB, err := r.db.DB()
	if err != nil {
		return err
	}
	return sqlDB.Close()
}

// DB exposes the handle for tests that need to inspect what was actually
// written. Nothing in the running service uses it.
func (r *Repository) DB() *gorm.DB { return r.db }

/* ------------------------------- users -------------------------------- */

func (r *Repository) CountUsersByEmail(email string) (int64, error) {
	var count int64
	err := r.db.Model(&model.User{}).Where("email = ?", email).Count(&count).Error
	return count, err
}

func (r *Repository) CreateUser(user model.User) error { return r.db.Create(&user).Error }

func (r *Repository) UserByEmail(email string) (model.User, error) {
	var user model.User
	err := r.db.Where("email = ?", email).First(&user).Error
	return user, err
}

func (r *Repository) UserByID(id string) (model.User, error) {
	var user model.User
	err := r.db.First(&user, "id = ?", id).Error
	return user, err
}

// SearchUsers finds people to add to a team. Capped and requiring a query,
// so the endpoint answers "who is this person" without also answering "list
// everyone who works here".
func (r *Repository) SearchUsers(query string, limit int) ([]model.Member, error) {
	users := []model.Member{}
	like := "%" + query + "%"
	err := r.db.Model(&model.User{}).
		Select("users.id, users.email, users.name").
		Where("users.name LIKE ? OR users.email LIKE ?", like, like).
		Order("users.name").
		Limit(limit).
		Scan(&users).Error
	return users, err
}

/* ------------------------------ sessions ------------------------------ */

func (r *Repository) CreateSession(session model.Session) error { return r.db.Create(&session).Error }

func (r *Repository) SessionByToken(token string) (model.Session, error) {
	var session model.Session
	err := r.db.First(&session, "token = ?", token).Error
	return session, err
}

func (r *Repository) DeleteSession(token string) {
	r.db.Delete(&model.Session{}, "token = ?", token)
}

/* ------------------------------- teams -------------------------------- */

// CreateTeam makes the creator its owner in the same transaction: a team
// without an owner would be unmanageable the moment it existed.
func (r *Repository) CreateTeam(team model.Team, ownerID string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&team).Error; err != nil {
			return err
		}
		return tx.Create(&model.TeamMember{
			TeamID: team.ID, UserID: ownerID, Role: model.RoleOwner, JoinedAt: time.Now().UTC(),
		}).Error
	})
}

func (r *Repository) TeamsForUser(userID string) ([]model.TeamView, error) {
	teams := []model.TeamView{}
	err := r.db.Model(&model.Team{}).
		Select("teams.id, teams.name, team_members.role AS role").
		Joins("JOIN team_members ON team_members.team_id = teams.id").
		Where("team_members.user_id = ?", userID).
		Order("teams.name").
		Scan(&teams).Error
	return teams, err
}

func (r *Repository) Member(teamID, userID string) (model.TeamMember, error) {
	var member model.TeamMember
	err := r.db.First(&member, "team_id = ? AND user_id = ?", teamID, userID).Error
	return member, err
}

func (r *Repository) Members(teamID string) ([]model.Member, error) {
	members := []model.Member{}
	err := r.db.Model(&model.TeamMember{}).
		Select("users.id, users.email, users.name, team_members.role, team_members.joined_at").
		Joins("JOIN users ON users.id = team_members.user_id").
		Where("team_members.team_id = ?", teamID).
		Order("users.name").
		Scan(&members).Error
	return members, err
}

func (r *Repository) AddMember(member model.TeamMember) error {
	// Already a member is not an error — adding someone twice is a
	// double-click, not a conflict worth reporting.
	return r.db.Clauses(clause.OnConflict{DoNothing: true}).Create(&member).Error
}

func (r *Repository) RemoveMember(teamID, userID string) error {
	return r.db.Delete(&model.TeamMember{}, "team_id = ? AND user_id = ?", teamID, userID).Error
}

/* --------------------------- team settings ---------------------------- */

func (r *Repository) TeamSettings(teamID string) (model.TeamSettings, error) {
	var settings model.TeamSettings
	err := r.db.First(&settings, "team_id = ?", teamID).Error
	return settings, err
}

func (r *Repository) SaveTeamSettings(settings model.TeamSettings) error {
	// Upsert: a team has one row, created the first time anyone saves.
	return r.db.Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "team_id"}},
		DoUpdates: clause.AssignmentColumns([]string{
			"jql", "approve_status", "reject_status", "language", "updated_by", "updated_at",
		}),
	}).Create(&settings).Error
}

/* ----------------------------- team notes ----------------------------- */

func (r *Repository) TeamNotes(teamID string) ([]model.TeamNote, error) {
	notes := []model.TeamNote{}
	err := r.db.Where("team_id = ?", teamID).Order("created_at").Find(&notes).Error
	return notes, err
}

func (r *Repository) CreateTeamNote(note model.TeamNote) error { return r.db.Create(&note).Error }

func (r *Repository) DeleteTeamNote(teamID, noteID string) (bool, error) {
	// Scoped by team as well as id: an id from another team must not be
	// deletable just because the caller knows it.
	result := r.db.Delete(&model.TeamNote{}, "team_id = ? AND id = ?", teamID, noteID)
	return result.RowsAffected > 0, result.Error
}

/* ---------------------------- assignments ----------------------------- */

// UpsertAssignment replaces any existing assignment for the issue — one
// reviewer at a time, enforced by the key rather than by remembering.
func (r *Repository) UpsertAssignment(assignment model.Assignment) error {
	return r.db.Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "team_id"}, {Name: "issue_key"}},
		DoUpdates: clause.AssignmentColumns([]string{
			"assignee_id", "assigned_by", "note", "summary", "status", "assigned_at",
		}),
	}).Create(&assignment).Error
}

func (r *Repository) AssignmentsForUser(userID string) ([]model.AssignmentView, error) {
	items := []model.AssignmentView{}
	err := r.db.Model(&model.Assignment{}).
		Select(`assignments.team_id, teams.name AS team_name, assignments.issue_key,
		        assignments.summary, assignments.note, assignments.status, assignments.assigned_at,
		        by.name AS assigned_by_name, by.email AS assigned_by_email`).
		Joins("JOIN teams ON teams.id = assignments.team_id").
		Joins("JOIN users by ON by.id = assignments.assigned_by").
		Where("assignments.assignee_id = ? AND assignments.status = ?", userID, model.StatusOpen).
		Order("assignments.assigned_at").
		Scan(&items).Error
	return items, err
}

func (r *Repository) AssignmentsForTeam(teamID string) ([]model.AssignmentView, error) {
	items := []model.AssignmentView{}
	err := r.db.Model(&model.Assignment{}).
		Select(`assignments.issue_key, assignments.summary, assignments.note, assignments.status,
		        assignments.assigned_at, assignee.id AS assignee_id, assignee.name AS assignee_name,
		        by.name AS assigned_by_name`).
		Joins("JOIN users assignee ON assignee.id = assignments.assignee_id").
		Joins("JOIN users by ON by.id = assignments.assigned_by").
		Where("assignments.team_id = ?", teamID).
		Order("assignments.assigned_at DESC").
		Scan(&items).Error
	return items, err
}

func (r *Repository) CloseAssignment(teamID, issueKey string) (bool, error) {
	result := r.db.Model(&model.Assignment{}).
		Where("team_id = ? AND issue_key = ?", teamID, issueKey).
		Update("status", model.StatusDone)
	return result.RowsAffected > 0, result.Error
}

/* ------------------------------ decisions ----------------------------- */

// RecordDecision overwrites the team's record for that issue: one current
// outcome per issue, replaced when it is reviewed again.
func (r *Repository) RecordDecision(decision model.Decision) error {
	return r.db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "team_id"}, {Name: "issue_key"}},
		UpdateAll: true,
	}).Create(&decision).Error
}

// DecisionsForTeam joins the decider's name in SQL rather than making the
// caller resolve ids — the same reason AssignmentsForUser does.
func (r *Repository) DecisionsForTeam(teamID string) ([]model.DecisionView, error) {
	var views []model.DecisionView
	err := r.db.Table("decisions").
		Select("decisions.issue_key, decisions.decision, decisions.severity, "+
			"decisions.summary, decisions.note, decisions.decided_at, users.name AS decided_by_name").
		Joins("LEFT JOIN users ON users.id = decisions.decided_by").
		Where("decisions.team_id = ?", teamID).
		Order("decisions.decided_at DESC").
		Scan(&views).Error
	return views, err
}
