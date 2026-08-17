// Package model holds the shapes that cross layer boundaries: what is
// stored, and what is read back. It depends on nothing else in this
// service, so every other layer can depend on it without creating a cycle.
package model

import "time"

type User struct {
	ID    string `gorm:"primaryKey" json:"id"`
	Email string `gorm:"uniqueIndex;not null;collate:NOCASE" json:"email"`
	Name  string `gorm:"not null" json:"name"`
	// Never serialised: `json:"-"` is the difference between an API that
	// returns users and one that leaks password hashes.
	PasswordHash string    `gorm:"not null" json:"-"`
	CreatedAt    time.Time `json:"createdAt"`
}

type Team struct {
	ID        string    `gorm:"primaryKey" json:"id"`
	Name      string    `gorm:"not null" json:"name"`
	CreatedBy string    `gorm:"not null" json:"createdBy"`
	CreatedAt time.Time `json:"createdAt"`
}

// TeamMember is the authorisation record: membership, not merely being
// logged in, is what grants access to anything team-scoped.
type TeamMember struct {
	TeamID string `gorm:"primaryKey" json:"teamId"`
	UserID string `gorm:"primaryKey" json:"userId"`
	// RoleOwner may add and remove people; RoleMember may not.
	Role     string    `gorm:"not null;default:member" json:"role"`
	JoinedAt time.Time `json:"joinedAt"`
}

const (
	RoleOwner  = "owner"
	RoleMember = "member"
)

type Session struct {
	Token     string    `gorm:"primaryKey" json:"-"`
	UserID    string    `gorm:"index;not null" json:"userId"`
	CreatedAt time.Time `json:"createdAt"`
	ExpiresAt time.Time `gorm:"not null" json:"expiresAt"`
}

// Assignment carries one issue per team: the composite primary key enforces
// "one reviewer at a time", so reassigning replaces the row rather than
// leaving service code to remember to clean up.
type Assignment struct {
	TeamID     string `gorm:"primaryKey" json:"teamId"`
	IssueKey   string `gorm:"primaryKey" json:"issueKey"`
	AssigneeID string `gorm:"index:idx_assignee_status;not null" json:"assigneeId"`
	AssignedBy string `gorm:"not null" json:"assignedBy"`
	Note       string `json:"note,omitempty"`
	// What the assigner knew at the time — never the review itself.
	Summary    string    `json:"summary,omitempty"`
	Status     string    `gorm:"index:idx_assignee_status;not null;default:open" json:"status"`
	AssignedAt time.Time `json:"assignedAt"`
}

const (
	StatusOpen = "open"
	StatusDone = "done"
)

// TeamSettings is what a review *means* for this team: which issues count,
// where they go afterwards, and what language the result is written in.
//
// Team-wide rather than per-machine because everyone here writes to the
// same Jira. Two reviewers looking at different queues, or moving issues to
// different statuses, is not a preference — it is a disagreement nobody
// noticed. Credentials and the local safety switch stay on each machine.
type TeamSettings struct {
	TeamID        string    `gorm:"primaryKey" json:"teamId"`
	JQL           string    `json:"jql"`
	ApproveStatus string    `json:"approveStatus"`
	RejectStatus  string    `json:"rejectStatus"`
	Language      string    `json:"language"`
	UpdatedBy     string    `json:"updatedBy,omitempty"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

// TeamNote is a standing decision about what does *not* count as a problem
// here — "don't flag missing tests in this repo". Accumulated team
// knowledge, which is exactly the sort of thing that dies on one laptop.
type TeamNote struct {
	ID     string `gorm:"primaryKey" json:"id"`
	TeamID string `gorm:"index;not null" json:"teamId"`
	// "global" applies everywhere; "repo" only to ProjectPath.
	Scope       string    `gorm:"not null;default:global" json:"scope"`
	ProjectPath string    `json:"projectPath,omitempty"`
	Text        string    `gorm:"not null" json:"text"`
	CreatedBy   string    `json:"createdBy,omitempty"`
	CreatedAt   time.Time `json:"createdAt"`
}

const (
	ScopeGlobal = "global"
	ScopeRepo   = "repo"
)

/* ------------------------- read-only view models ----------------------- */

// TeamView is a team plus the caller's role in it. A separate type rather
// than a field on Team tagged `gorm:"-"`: an ignored field is ignored on
// the way in *and* on the way out, so a joined role would never populate.
type TeamView struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Role string `json:"role"`
}

type Member struct {
	ID       string    `json:"id"`
	Email    string    `json:"email"`
	Name     string    `json:"name"`
	Role     string    `json:"role"`
	JoinedAt time.Time `json:"joinedAt"`
}

// AssignmentView flattens the joins a reader actually wants: names rather
// than ids, so a client need not look people up to render a row.
type AssignmentView struct {
	TeamID          string    `json:"teamId,omitempty"`
	TeamName        string    `json:"teamName,omitempty"`
	IssueKey        string    `json:"issueKey"`
	Summary         string    `json:"summary,omitempty"`
	Note            string    `json:"note,omitempty"`
	Status          string    `json:"status"`
	AssignedAt      time.Time `json:"assignedAt"`
	AssigneeID      string    `json:"assigneeId,omitempty"`
	AssigneeName    string    `json:"assigneeName,omitempty"`
	AssignedByName  string    `json:"assignedByName,omitempty"`
	AssignedByEmail string    `json:"assignedByEmail,omitempty"`
}

// Decision is where a review landed: approved and posted, or sent back.
//
// The composite key is team+issue, so an issue that is reviewed a second
// time replaces its own row — the list answers "where did this end up?",
// not "how many times did we look at it?".
//
// It carries no review text. What was written about someone's code is for
// the person who asked; the team only needs to know the call.
type Decision struct {
	TeamID   string `gorm:"primaryKey" json:"teamId"`
	IssueKey string `gorm:"primaryKey" json:"issueKey"`
	// DecisionApproved or DecisionRejected.
	Decision string `gorm:"index;not null" json:"decision"`
	Severity string `json:"severity,omitempty"`
	Summary  string `json:"summary,omitempty"`
	// The reviewer's own words when sending something back. Optional: the
	// review itself already explains why.
	Note      string    `json:"note,omitempty"`
	DecidedBy string    `gorm:"not null" json:"decidedBy"`
	DecidedAt time.Time `gorm:"index" json:"decidedAt"`
}

const (
	DecisionApproved = "approved"
	DecisionRejected = "rejected"
)

// DecisionView is a Decision with the decider's name resolved, so a client
// can render a row without a second request per person.
type DecisionView struct {
	IssueKey      string    `json:"issueKey"`
	Decision      string    `json:"decision"`
	Severity      string    `json:"severity,omitempty"`
	Summary       string    `json:"summary,omitempty"`
	Note          string    `json:"note,omitempty"`
	DecidedAt     time.Time `json:"decidedAt"`
	DecidedByName string    `json:"decidedByName,omitempty"`
}
