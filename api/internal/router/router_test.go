package router_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"gorm.io/gorm/logger"

	"github.com/onuragtas/revify/internal/model"
	"github.com/onuragtas/revify/internal/repository"
	"github.com/onuragtas/revify/internal/router"
)

// Tests run against the assembled router rather than a service in
// isolation: the things most worth protecting here — who may call what —
// are properties of the wiring, and a service test would pass while the
// route was mounted outside its guard.

const goodPassword = "correct-horse-battery"

type harness struct {
	app  *fiber.App
	repo *repository.Repository
}

func newHarness(t *testing.T) harness {
	t.Helper()
	repo, err := repository.Open(filepath.Join(t.TempDir(), "api.db"), logger.Discard)
	if err != nil {
		t.Fatalf("open repository: %v", err)
	}
	t.Cleanup(func() { _ = repo.Close() })
	return harness{app: router.New(repo, time.Hour), repo: repo}
}

type response struct {
	code   int
	body   map[string]any
	cookie string
}

func (h harness) call(t *testing.T, method, path, cookie string, body any) response {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			t.Fatalf("encode: %v", err)
		}
	}
	req := httptest.NewRequest(method, path, &buf)
	req.Header.Set("Content-Type", "application/json")
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}

	res, err := h.app.Test(req, -1)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer func() { _ = res.Body.Close() }()

	raw, _ := io.ReadAll(res.Body)
	out := response{code: res.StatusCode}
	_ = json.Unmarshal(raw, &out.body)
	for _, c := range res.Cookies() {
		if c.Name == "ar_session" && c.Value != "" {
			out.cookie = "ar_session=" + c.Value
		}
	}
	return out
}

type account struct{ id, cookie string }

func (h harness) signUp(t *testing.T, email, name string) account {
	t.Helper()
	res := h.call(t, "POST", "/api/auth/register", "", map[string]string{
		"email": email, "name": name, "password": goodPassword,
	})
	if res.code != http.StatusCreated {
		t.Fatalf("register %s: %d (%v)", email, res.code, res.body)
	}
	return account{id: res.body["user"].(map[string]any)["id"].(string), cookie: res.cookie}
}

func (h harness) createTeam(t *testing.T, cookie, name string) string {
	t.Helper()
	res := h.call(t, "POST", "/api/teams/", cookie, map[string]string{"name": name})
	if res.code != http.StatusCreated {
		t.Fatalf("create team: %d %v", res.code, res.body)
	}
	return res.body["team"].(map[string]any)["id"].(string)
}

func items(t *testing.T, res response) []any {
	t.Helper()
	list, ok := res.body["items"].([]any)
	if !ok {
		t.Fatalf("expected items, got %v", res.body)
	}
	return list
}

/* --------------------------------- auth -------------------------------- */

func TestRegisterIdentifiesAndLogsOut(t *testing.T) {
	h := newHarness(t)
	ada := h.signUp(t, "a@example.com", "Ada")

	me := h.call(t, "GET", "/api/auth/me", ada.cookie, nil)
	user := me.body["user"].(map[string]any)
	if user["email"] != "a@example.com" || user["name"] != "Ada" {
		t.Fatalf("unexpected user: %v", user)
	}

	h.call(t, "POST", "/api/auth/logout", ada.cookie, nil)
	if after := h.call(t, "GET", "/api/auth/me", ada.cookie, nil); after.body["user"] != nil {
		t.Fatalf("session survived logout: %v", after.body)
	}
}

func TestPasswordIsNeverStoredOrReturned(t *testing.T) {
	h := newHarness(t)
	res := h.call(t, "POST", "/api/auth/register", "", map[string]string{
		"email": "a@example.com", "name": "Ada", "password": goodPassword,
	})

	// `json:"-"` on the hash is the difference between an API that returns
	// users and one that leaks hashes.
	if _, leaked := res.body["user"].(map[string]any)["passwordHash"]; leaked {
		t.Fatal("the response carries a password hash")
	}

	var stored model.User
	if err := h.repo.DB().First(&stored).Error; err != nil {
		t.Fatalf("read user: %v", err)
	}
	if strings.Contains(stored.PasswordHash, goodPassword) {
		t.Fatal("the password itself is in the database")
	}
	if !strings.HasPrefix(stored.PasswordHash, "$2a$") {
		t.Fatalf("expected a bcrypt hash, got %q", stored.PasswordHash)
	}
}

func TestLoginGivesNothingAwayAboutWhoExists(t *testing.T) {
	h := newHarness(t)
	h.signUp(t, "a@example.com", "Ada")

	wrongPassword := h.call(t, "POST", "/api/auth/login", "", map[string]string{
		"email": "a@example.com", "password": "nope",
	})
	unknownUser := h.call(t, "POST", "/api/auth/login", "", map[string]string{
		"email": "ghost@example.com", "password": "nope",
	})

	// Telling these apart turns login into a way to find out who works here.
	if wrongPassword.code != http.StatusUnauthorized || unknownUser.code != http.StatusUnauthorized {
		t.Fatalf("codes differ: %d vs %d", wrongPassword.code, unknownUser.code)
	}
	if wrongPassword.body["error"] != unknownUser.body["error"] {
		t.Fatalf("messages differ: %v vs %v", wrongPassword.body["error"], unknownUser.body["error"])
	}
}

func TestLoginAcceptsCorrectPasswordAndIgnoresEmailCase(t *testing.T) {
	h := newHarness(t)
	h.signUp(t, "a@example.com", "Ada")

	res := h.call(t, "POST", "/api/auth/login", "", map[string]string{
		"email": "A@Example.com", "password": goodPassword,
	})
	if res.code != http.StatusOK || res.cookie == "" {
		t.Fatalf("login failed: %d %v", res.code, res.body)
	}
}

func TestRegisterRejectsWeakAndDuplicate(t *testing.T) {
	h := newHarness(t)
	h.signUp(t, "a@example.com", "Ada")

	short := h.call(t, "POST", "/api/auth/register", "", map[string]string{
		"email": "b@example.com", "name": "Bo", "password": "short",
	})
	if short.code != http.StatusBadRequest {
		t.Fatalf("short password accepted: %d", short.code)
	}

	// bcrypt silently truncates at 72 bytes, which would make two different
	// long passwords interchangeable.
	long := h.call(t, "POST", "/api/auth/register", "", map[string]string{
		"email": "c@example.com", "name": "Cem", "password": strings.Repeat("x", 100),
	})
	if long.code != http.StatusBadRequest {
		t.Fatalf("over-long password accepted: %d", long.code)
	}

	dup := h.call(t, "POST", "/api/auth/register", "", map[string]string{
		"email": "a@example.com", "name": "Other", "password": goodPassword,
	})
	if dup.code != http.StatusConflict {
		t.Fatalf("duplicate email accepted: %d", dup.code)
	}
}

func TestAnonymousIsTurnedAway(t *testing.T) {
	h := newHarness(t)
	for _, path := range []string{"/api/teams/", "/api/assignments/mine", "/api/users?q=ada"} {
		if res := h.call(t, "GET", path, "", nil); res.code != http.StatusUnauthorized {
			t.Fatalf("%s allowed anonymously: %d", path, res.code)
		}
	}
}

/* ----------------------------- user search ----------------------------- */

func TestUserSearchFindsPeopleToAdd(t *testing.T) {
	h := newHarness(t)
	ada := h.signUp(t, "a@example.com", "Ada Lovelace")
	h.signUp(t, "esma@example.com", "Esma Nur")

	byName := items(t, h.call(t, "GET", "/api/users?q=esma", ada.cookie, nil))
	if len(byName) != 1 || byName[0].(map[string]any)["name"] != "Esma Nur" {
		t.Fatalf("name search: %v", byName)
	}

	byEmail := items(t, h.call(t, "GET", "/api/users?q=example.com", ada.cookie, nil))
	if len(byEmail) != 2 {
		t.Fatalf("email search found %d", len(byEmail))
	}
}

func TestUserSearchRefusesToDumpTheDirectory(t *testing.T) {
	h := newHarness(t)
	ada := h.signUp(t, "a@example.com", "Ada")

	// Answering "who is Esma" is fine; answering "list everyone who works
	// here" is a different thing to hand out.
	for _, q := range []string{"", "a"} {
		if res := h.call(t, "GET", "/api/users?q="+q, ada.cookie, nil); res.code != http.StatusBadRequest {
			t.Fatalf("q=%q accepted: %d", q, res.code)
		}
	}
}

/* -------------------------------- teams -------------------------------- */

func TestCreatorBecomesOwnerAndMember(t *testing.T) {
	h := newHarness(t)
	ada := h.signUp(t, "a@example.com", "Ada")
	h.createTeam(t, ada.cookie, "Buy Journey")

	list := items(t, h.call(t, "GET", "/api/teams/", ada.cookie, nil))
	if len(list) != 1 || list[0].(map[string]any)["role"] != "owner" {
		t.Fatalf("creator is not owner: %v", list)
	}
}

func TestAddMemberByID(t *testing.T) {
	h := newHarness(t)
	ada := h.signUp(t, "a@example.com", "Ada")
	bo := h.signUp(t, "b@example.com", "Bo")
	team := h.createTeam(t, ada.cookie, "T")

	added := h.call(t, "POST", "/api/teams/"+team+"/members", ada.cookie,
		map[string]string{"userId": bo.id})
	if added.code != http.StatusCreated {
		t.Fatalf("add member: %d %v", added.code, added.body)
	}

	missing := h.call(t, "POST", "/api/teams/"+team+"/members", ada.cookie,
		map[string]string{"userId": "no-such-id"})
	if missing.code != http.StatusNotFound {
		t.Fatalf("unknown user accepted: %d", missing.code)
	}

	if got := len(items(t, h.call(t, "GET", "/api/teams/"+team+"/members", ada.cookie, nil))); got != 2 {
		t.Fatalf("expected 2 members, got %d", got)
	}
}

func TestTeamIsHiddenFromOutsiders(t *testing.T) {
	h := newHarness(t)
	ada := h.signUp(t, "a@example.com", "Ada")
	bo := h.signUp(t, "b@example.com", "Bo")
	team := h.createTeam(t, ada.cookie, "T")

	// Being logged in says nothing about which teams you may look at.
	if res := h.call(t, "GET", "/api/teams/"+team+"/members", bo.cookie, nil); res.code != http.StatusForbidden {
		t.Fatalf("outsider read members: %d", res.code)
	}
	if got := len(items(t, h.call(t, "GET", "/api/teams/", bo.cookie, nil))); got != 0 {
		t.Fatalf("outsider sees %d teams", got)
	}
}

func TestOnlyOwnerManagesMembers(t *testing.T) {
	h := newHarness(t)
	ada := h.signUp(t, "a@example.com", "Ada")
	bo := h.signUp(t, "b@example.com", "Bo")
	cem := h.signUp(t, "c@example.com", "Cem")
	team := h.createTeam(t, ada.cookie, "T")
	h.call(t, "POST", "/api/teams/"+team+"/members", ada.cookie, map[string]string{"userId": bo.id})

	byMember := h.call(t, "POST", "/api/teams/"+team+"/members", bo.cookie,
		map[string]string{"userId": cem.id})
	if byMember.code != http.StatusForbidden {
		t.Fatalf("a plain member added someone: %d", byMember.code)
	}

	// A team without its owner would be unmanageable.
	if self := h.call(t, "DELETE", "/api/teams/"+team+"/members/"+ada.id, ada.cookie, nil); self.code != http.StatusBadRequest {
		t.Fatalf("owner removed themselves: %d", self.code)
	}
}

/* ----------------------------- assignments ----------------------------- */

func (h harness) teamOfTwo(t *testing.T) (ada, bo account, team string) {
	t.Helper()
	ada = h.signUp(t, "a@example.com", "Ada")
	bo = h.signUp(t, "b@example.com", "Bo")
	team = h.createTeam(t, ada.cookie, "T")
	h.call(t, "POST", "/api/teams/"+team+"/members", ada.cookie, map[string]string{"userId": bo.id})
	return
}

func TestAssignHandsWorkToATeamMate(t *testing.T) {
	h := newHarness(t)
	ada, bo, team := h.teamOfTwo(t)

	res := h.call(t, "POST", "/api/teams/"+team+"/assignments", ada.cookie, map[string]string{
		"issueKey": "BUY-2455", "assigneeId": bo.id, "summary": "Barcode listing", "note": "Mongo tarafına bak",
	})
	if res.code != http.StatusCreated {
		t.Fatalf("assign: %d %v", res.code, res.body)
	}

	mine := items(t, h.call(t, "GET", "/api/assignments/mine", bo.cookie, nil))
	if len(mine) != 1 {
		t.Fatalf("assignee sees %d assignments", len(mine))
	}
	got := mine[0].(map[string]any)
	if got["issueKey"] != "BUY-2455" || got["note"] != "Mongo tarafına bak" || got["assignedByName"] != "Ada" {
		t.Fatalf("unexpected assignment: %v", got)
	}

	if n := len(items(t, h.call(t, "GET", "/api/assignments/mine", ada.cookie, nil))); n != 0 {
		t.Fatalf("assigner still holds %d", n)
	}
}

func TestReassignReplacesRatherThanAccumulates(t *testing.T) {
	h := newHarness(t)
	ada, bo, team := h.teamOfTwo(t)

	h.call(t, "POST", "/api/teams/"+team+"/assignments", ada.cookie,
		map[string]string{"issueKey": "BUY-1", "assigneeId": bo.id})
	h.call(t, "POST", "/api/teams/"+team+"/assignments", ada.cookie,
		map[string]string{"issueKey": "BUY-1", "assigneeId": ada.id})

	all := items(t, h.call(t, "GET", "/api/teams/"+team+"/assignments", ada.cookie, nil))
	if len(all) != 1 || all[0].(map[string]any)["assigneeName"] != "Ada" {
		t.Fatalf("reassign did not replace: %v", all)
	}
	if n := len(items(t, h.call(t, "GET", "/api/assignments/mine", bo.cookie, nil))); n != 0 {
		t.Fatalf("previous assignee still holds %d", n)
	}
}

func TestCannotAssignOutsideTheTeam(t *testing.T) {
	h := newHarness(t)
	ada, _, team := h.teamOfTwo(t)
	outsider := h.signUp(t, "z@example.com", "Zoe")

	// Otherwise this endpoint would let anyone push work onto any account.
	res := h.call(t, "POST", "/api/teams/"+team+"/assignments", ada.cookie,
		map[string]string{"issueKey": "BUY-1", "assigneeId": outsider.id})
	if res.code != http.StatusBadRequest {
		t.Fatalf("assigned to an outsider: %d", res.code)
	}
}

func TestCloseAssignment(t *testing.T) {
	h := newHarness(t)
	ada, bo, team := h.teamOfTwo(t)
	outsider := h.signUp(t, "z@example.com", "Zoe")
	h.call(t, "POST", "/api/teams/"+team+"/assignments", ada.cookie,
		map[string]string{"issueKey": "BUY-1", "assigneeId": bo.id})

	if res := h.call(t, "POST", "/api/teams/"+team+"/assignments/BUY-1/close", outsider.cookie, nil); res.code != http.StatusForbidden {
		t.Fatalf("outsider closed an assignment: %d", res.code)
	}
	if res := h.call(t, "POST", "/api/teams/"+team+"/assignments/BUY-1/close", bo.cookie, nil); res.code != http.StatusOK {
		t.Fatalf("assignee could not close: %d", res.code)
	}
	if n := len(items(t, h.call(t, "GET", "/api/assignments/mine", bo.cookie, nil))); n != 0 {
		t.Fatalf("closed assignment still open for %d", n)
	}

	if missing := h.call(t, "POST", "/api/teams/"+team+"/assignments/NOPE-1/close", ada.cookie, nil); missing.code != http.StatusNotFound {
		t.Fatalf("closing a non-existent assignment: %d", missing.code)
	}
}

/* --------------------------- team settings ----------------------------- */

func TestTeamSettingsDefaultBeforeAnyoneSavesThem(t *testing.T) {
	h := newHarness(t)
	ada := h.signUp(t, "a@example.com", "Ada")
	team := h.createTeam(t, ada.cookie, "T")

	// A team that has not configured itself yet is a normal state, not an
	// error — the client needs something coherent to render.
	res := h.call(t, "GET", "/api/teams/"+team+"/settings", ada.cookie, nil)
	if res.code != http.StatusOK {
		t.Fatalf("defaults not served: %d %v", res.code, res.body)
	}
	if res.body["role"] != "owner" {
		t.Fatalf("role should travel with the settings: %v", res.body)
	}
}

func TestOnlyOwnerChangesTeamSettings(t *testing.T) {
	h := newHarness(t)
	ada, bo, team := h.teamOfTwo(t)

	policy := map[string]string{
		"jql": "project = PROJ AND status = \"Code Review\"", "approveStatus": "Ready for Stage",
		"rejectStatus": "In Development", "language": "Turkish",
	}

	saved := h.call(t, "PUT", "/api/teams/"+team+"/settings", ada.cookie, policy)
	if saved.code != http.StatusOK {
		t.Fatalf("owner could not save: %d %v", saved.code, saved.body)
	}

	// A JQL changed by mistake reshapes everyone's queue, so members read
	// but do not write.
	byMember := h.call(t, "PUT", "/api/teams/"+team+"/settings", bo.cookie, policy)
	if byMember.code != http.StatusForbidden {
		t.Fatalf("a plain member rewrote team policy: %d", byMember.code)
	}

	read := h.call(t, "GET", "/api/teams/"+team+"/settings", bo.cookie, nil)
	got := read.body["settings"].(map[string]any)
	if got["language"] != "Turkish" || got["approveStatus"] != "Ready for Stage" {
		t.Fatalf("member sees stale settings: %v", got)
	}
	if read.body["role"] != "member" {
		t.Fatalf("member told it is %v", read.body["role"])
	}
}

func TestTeamSettingsRejectBlankPolicy(t *testing.T) {
	h := newHarness(t)
	ada := h.signUp(t, "a@example.com", "Ada")
	team := h.createTeam(t, ada.cookie, "T")

	// An empty status name fails at the moment someone approves — the worst
	// possible moment to discover it.
	blankStatus := h.call(t, "PUT", "/api/teams/"+team+"/settings", ada.cookie, map[string]string{
		"jql": "project = PROJ", "approveStatus": "", "rejectStatus": "In Development",
	})
	if blankStatus.code != http.StatusBadRequest {
		t.Fatalf("blank status accepted: %d", blankStatus.code)
	}

	blankJQL := h.call(t, "PUT", "/api/teams/"+team+"/settings", ada.cookie, map[string]string{
		"jql": "  ", "approveStatus": "A", "rejectStatus": "B",
	})
	if blankJQL.code != http.StatusBadRequest {
		t.Fatalf("blank JQL accepted: %d", blankJQL.code)
	}
}

/* ----------------------------- team notes ------------------------------ */

func TestNotesAreSharedAndOwnerManaged(t *testing.T) {
	h := newHarness(t)
	ada, bo, team := h.teamOfTwo(t)

	added := h.call(t, "POST", "/api/teams/"+team+"/notes", ada.cookie, map[string]string{
		"scope": "global", "text": "Bu projede test eksikliğini bulgu yazma",
	})
	if added.code != http.StatusCreated {
		t.Fatalf("owner could not add a note: %d %v", added.code, added.body)
	}

	// The point of moving notes here: a new team-mate starts with the same
	// accumulated rules instead of learning them again.
	seen := items(t, h.call(t, "GET", "/api/teams/"+team+"/notes", bo.cookie, nil))
	if len(seen) != 1 || seen[0].(map[string]any)["text"] != "Bu projede test eksikliğini bulgu yazma" {
		t.Fatalf("member does not see the note: %v", seen)
	}

	byMember := h.call(t, "POST", "/api/teams/"+team+"/notes", bo.cookie, map[string]string{
		"scope": "global", "text": "başka",
	})
	if byMember.code != http.StatusForbidden {
		t.Fatalf("a plain member added a note: %d", byMember.code)
	}
}

func TestRepoNoteNeedsARepo(t *testing.T) {
	h := newHarness(t)
	ada := h.signUp(t, "a@example.com", "Ada")
	team := h.createTeam(t, ada.cookie, "T")

	// A repo-scoped note with no repo would apply to nothing, silently.
	res := h.call(t, "POST", "/api/teams/"+team+"/notes", ada.cookie, map[string]string{
		"scope": "repo", "text": "sadece burada",
	})
	if res.code != http.StatusBadRequest {
		t.Fatalf("repo note without a repo accepted: %d", res.code)
	}
}

func TestNotesCannotBeDeletedAcrossTeams(t *testing.T) {
	h := newHarness(t)
	ada := h.signUp(t, "a@example.com", "Ada")
	mine := h.createTeam(t, ada.cookie, "Mine")
	other := h.createTeam(t, ada.cookie, "Other")

	added := h.call(t, "POST", "/api/teams/"+mine+"/notes", ada.cookie, map[string]string{
		"scope": "global", "text": "note",
	})
	noteID := added.body["note"].(map[string]any)["id"].(string)

	// Knowing an id must not be enough — deletion is scoped by team too.
	wrongTeam := h.call(t, "DELETE", "/api/teams/"+other+"/notes/"+noteID, ada.cookie, nil)
	if wrongTeam.code != http.StatusNotFound {
		t.Fatalf("deleted another team's note: %d", wrongTeam.code)
	}

	right := h.call(t, "DELETE", "/api/teams/"+mine+"/notes/"+noteID, ada.cookie, nil)
	if right.code != http.StatusOK {
		t.Fatalf("could not delete own note: %d", right.code)
	}
}

/* ------------------------------ hardening ------------------------------ */

func TestLoginIsThrottled(t *testing.T) {
	h := newHarness(t)
	h.signUp(t, "a@example.com", "Ada")

	// The limiter counts every attempt, not just failures: counting only
	// failures would let an attacker reset the window with one good login.
	var blocked bool
	for i := 0; i < 15; i++ {
		res := h.call(t, "POST", "/api/auth/login", "", map[string]string{
			"email": "a@example.com", "password": "guess-" + string(rune('a'+i)),
		})
		if res.code == http.StatusTooManyRequests {
			blocked = true
			break
		}
	}
	if !blocked {
		t.Fatal("unlimited password guessing is allowed")
	}
}

func TestThrottleDoesNotLeakWhoExists(t *testing.T) {
	h := newHarness(t)
	h.signUp(t, "a@example.com", "Ada")

	// Being throttled must not become a way to tell a real account from a
	// made-up one — both hit the same limiter on the same key.
	for i := 0; i < 12; i++ {
		h.call(t, "POST", "/api/auth/login", "", map[string]string{"email": "a@example.com", "password": "x"})
	}
	known := h.call(t, "POST", "/api/auth/login", "", map[string]string{"email": "a@example.com", "password": "x"})
	unknown := h.call(t, "POST", "/api/auth/login", "", map[string]string{"email": "ghost@example.com", "password": "x"})

	if known.code != unknown.code {
		t.Fatalf("throttled responses differ: %d vs %d", known.code, unknown.code)
	}
}

func TestSessionCookieIsHardened(t *testing.T) {
	h := newHarness(t)

	req := httptest.NewRequest("POST", "/api/auth/register", strings.NewReader(
		`{"email":"a@example.com","name":"Ada","password":"`+goodPassword+`"}`))
	req.Header.Set("Content-Type", "application/json")
	res, err := h.app.Test(req, -1)
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	defer func() { _ = res.Body.Close() }()

	var session *http.Cookie
	for _, c := range res.Cookies() {
		if c.Name == "ar_session" {
			session = c
		}
	}
	if session == nil {
		t.Fatal("no session cookie")
	}
	if !session.HttpOnly {
		t.Error("session cookie is readable by page scripts")
	}
	if session.SameSite != http.SameSiteLaxMode {
		t.Errorf("SameSite is %v, so another site could ride the cookie", session.SameSite)
	}
	// Secure follows the request: plain HTTP here, so it must be off —
	// otherwise nobody could sign in during development.
	if session.Secure {
		t.Error("Secure set on a plain-HTTP request would drop the cookie on localhost")
	}
}

func TestSessionCookieIsSecureBehindTLS(t *testing.T) {
	h := newHarness(t)

	req := httptest.NewRequest("POST", "/api/auth/register", strings.NewReader(
		`{"email":"a@example.com","name":"Ada","password":"`+goodPassword+`"}`))
	req.Header.Set("Content-Type", "application/json")
	// What a TLS-terminating proxy sends — which is how this is deployed.
	req.Header.Set("X-Forwarded-Proto", "https")

	res, err := h.app.Test(req, -1)
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	defer func() { _ = res.Body.Close() }()

	for _, c := range res.Cookies() {
		if c.Name == "ar_session" && !c.Secure {
			t.Fatal("session cookie may travel over plain HTTP behind a TLS proxy")
		}
	}
}
