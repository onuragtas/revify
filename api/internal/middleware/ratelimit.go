package middleware

import (
	"sync"
	"time"

	"github.com/gofiber/fiber/v2"
)

// LoginLimiter throttles credential guessing.
//
// Necessary at all because passwords are guessable and the endpoint is on
// the public internet; necessary *visibly* because this source is public,
// so nobody has to discover that /api/auth/login had no limit — they can
// read that it does.
//
// Keyed by IP rather than by email on purpose. Keying by email lets anyone
// lock a colleague out of their own account by guessing at it, which turns
// a defence into a denial of service.
type LoginLimiter struct {
	mu       sync.Mutex
	attempts map[string]*window
	max      int
	per      time.Duration
}

type window struct {
	count int
	until time.Time
}

func NewLoginLimiter(max int, per time.Duration) *LoginLimiter {
	return &LoginLimiter{attempts: map[string]*window{}, max: max, per: per}
}

// Handler counts every attempt, successful or not. Counting only failures
// would let an attacker reset the window with one known-good login.
func (l *LoginLimiter) Handler() fiber.Handler {
	return func(c *fiber.Ctx) error {
		key := c.IP()
		now := time.Now()

		l.mu.Lock()
		w, ok := l.attempts[key]
		if !ok || now.After(w.until) {
			w = &window{until: now.Add(l.per)}
			l.attempts[key] = w
		}
		w.count++
		blocked := w.count > l.max
		retryIn := int(time.Until(w.until).Seconds()) + 1

		// Expired windows would otherwise accumulate for every IP that ever
		// signed in. Swept here because this is the only place that walks
		// the map anyway.
		if len(l.attempts) > 1024 {
			for k, v := range l.attempts {
				if now.After(v.until) {
					delete(l.attempts, k)
				}
			}
		}
		l.mu.Unlock()

		if blocked {
			c.Set("Retry-After", itoa(retryIn))
			return c.Status(fiber.StatusTooManyRequests).
				JSON(fiber.Map{"error": "Çok fazla deneme. Biraz sonra tekrar dene."})
		}
		return c.Next()
	}
}

func itoa(n int) string {
	if n <= 0 {
		return "1"
	}
	digits := ""
	for n > 0 {
		digits = string(rune('0'+n%10)) + digits
		n /= 10
	}
	return digits
}
