package service

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"

	"github.com/onuragtas/revify/internal/model"
	"github.com/onuragtas/revify/internal/repository"
)

// Compared against when the email is unknown, so a wrong password and a
// non-existent account cost the same time as well as returning the same
// answer.
const dummyHash = "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy"

type Auth struct {
	repo       *repository.Repository
	sessionTTL time.Duration
}

func NewAuth(repo *repository.Repository, sessionTTL time.Duration) *Auth {
	return &Auth{repo: repo, sessionTTL: sessionTTL}
}

func NewID() string { return uuid.NewString() }

func randomToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func (a *Auth) Register(email, name, password string) (model.User, model.Session, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	name = strings.TrimSpace(name)

	switch {
	case !strings.Contains(email, "@"):
		return model.User{}, model.Session{}, fail(KindInvalid, "Geçerli bir e-posta gerekli.")
	case name == "":
		return model.User{}, model.Session{}, fail(KindInvalid, "İsim gerekli.")
	// Length is the rule that reliably helps; composition rules mostly
	// produce predictable passwords.
	case len(password) < 10:
		return model.User{}, model.Session{}, fail(KindInvalid, "Parola en az 10 karakter olmalı.")
	// bcrypt caps at 72 bytes and ignores the rest, which would make two
	// different long passwords interchangeable.
	case len(password) > 72:
		return model.User{}, model.Session{}, fail(KindInvalid, "Parola en fazla 72 karakter olabilir.")
	}

	count, err := a.repo.CountUsersByEmail(email)
	if err != nil {
		return model.User{}, model.Session{}, wrap(err, "Kayıt oluşturulamadı.")
	}
	if count > 0 {
		return model.User{}, model.Session{}, fail(KindConflict, "Bu e-posta zaten kayıtlı.")
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return model.User{}, model.Session{}, wrap(err, "Parola işlenemedi.")
	}

	user := model.User{
		ID: NewID(), Email: email, Name: name,
		PasswordHash: string(hash), CreatedAt: time.Now().UTC(),
	}
	if err := a.repo.CreateUser(user); err != nil {
		return model.User{}, model.Session{}, wrap(err, "Kayıt oluşturulamadı.")
	}

	session, err := a.newSession(user.ID)
	return user, session, err
}

func (a *Auth) Login(email, password string) (model.User, model.Session, error) {
	// One message for "no such user" and "wrong password": telling them
	// apart turns login into a way to enumerate who works here.
	const same = "E-posta veya parola hatalı."

	user, err := a.repo.UserByEmail(strings.ToLower(strings.TrimSpace(email)))
	if errors.Is(err, gorm.ErrRecordNotFound) {
		// Still hash, so the timing matches too.
		_ = bcrypt.CompareHashAndPassword([]byte(dummyHash), []byte(password))
		return model.User{}, model.Session{}, fail(KindUnauthorized, same)
	} else if err != nil {
		return model.User{}, model.Session{}, wrap(err, "Giriş yapılamadı.")
	}

	if bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)) != nil {
		return model.User{}, model.Session{}, fail(KindUnauthorized, same)
	}

	session, err := a.newSession(user.ID)
	return user, session, err
}

func (a *Auth) newSession(userID string) (model.Session, error) {
	token, err := randomToken()
	if err != nil {
		return model.Session{}, wrap(err, "Oturum açılamadı.")
	}
	session := model.Session{
		Token: token, UserID: userID,
		CreatedAt: time.Now().UTC(), ExpiresAt: time.Now().UTC().Add(a.sessionTTL),
	}
	if err := a.repo.CreateSession(session); err != nil {
		return model.Session{}, wrap(err, "Oturum açılamadı.")
	}
	return session, nil
}

func (a *Auth) Logout(token string) {
	if token != "" {
		a.repo.DeleteSession(token)
	}
}

// UserForToken resolves a session, deleting it if it has expired. The check
// runs on every request anyway, so expiring on sight costs nothing and
// removes the need for a sweeper.
func (a *Auth) UserForToken(token string) (model.User, bool) {
	if token == "" {
		return model.User{}, false
	}

	session, err := a.repo.SessionByToken(token)
	if err != nil {
		return model.User{}, false
	}
	if session.ExpiresAt.Before(time.Now().UTC()) {
		a.repo.DeleteSession(token)
		return model.User{}, false
	}

	user, err := a.repo.UserByID(session.UserID)
	if err != nil {
		return model.User{}, false
	}
	return user, true
}
