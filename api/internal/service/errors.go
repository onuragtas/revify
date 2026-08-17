// Package service holds the rules: what is allowed, what is required, and
// what each failure means. It knows nothing about HTTP.
//
// That is the point of the split. Statuses and JSON shapes are the
// handler's business, so the rules are expressed as typed failures here and
// mapped to codes in exactly one place (handler.Respond). Without that,
// every rule would carry an HTTP status around with it and the layering
// would be filing rather than design.
package service

import "errors"

type Kind int

const (
	KindInternal     Kind = iota
	KindInvalid           // the request itself is wrong
	KindUnauthorized      // not logged in, or wrong credentials
	KindForbidden         // logged in, but not allowed to do this
	KindNotFound          // the thing referred to does not exist
	KindConflict          // it exists already
)

type Error struct {
	Kind    Kind
	Message string
	err     error
}

func (e *Error) Error() string { return e.Message }
func (e *Error) Unwrap() error { return e.err }

func fail(kind Kind, message string) *Error { return &Error{Kind: kind, Message: message} }

func wrap(err error, message string) *Error {
	return &Error{Kind: KindInternal, Message: message, err: err}
}

// KindOf reports how a failure should be treated. Anything that is not one
// of ours is internal: an unexpected error is not a client's fault.
func KindOf(err error) (Kind, string) {
	var e *Error
	if errors.As(err, &e) {
		return e.Kind, e.Message
	}
	return KindInternal, "Beklenmeyen bir hata oluştu."
}
