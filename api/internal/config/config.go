// Package config reads the environment once, at startup, so no other layer
// has to reach for os.Getenv and every setting has one documented default.
package config

import (
	"os"
	"time"
)

type Config struct {
	Addr       string
	DBPath     string
	SessionTTL time.Duration
}

func Load() Config {
	return Config{
		Addr:   envOr("API_ADDR", ":4322"),
		DBPath: envOr("API_DB", "./api.db"),
		// Long enough that a reviewer is not logging in every morning,
		// short enough that a forgotten laptop stops working eventually.
		SessionTTL: 30 * 24 * time.Hour,
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
