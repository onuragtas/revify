// Command api is the Revify backend.
//
// It coordinates people — who exists, who is on which team, and who owes
// whom a review. It deliberately stores no Jira or GitLab credentials and
// no review text: those stay on each reviewer's own machine. That boundary
// is what keeps a shared service from becoming the one place worth breaking
// into.
package main

import (
	"log"
	"os"
	"os/signal"
	"syscall"

	"gorm.io/gorm/logger"

	"github.com/onuragtas/revify/internal/config"
	"github.com/onuragtas/revify/internal/repository"
	"github.com/onuragtas/revify/internal/router"
)

func main() {
	cfg := config.Load()

	// GORM logs every statement at Info by default, which turns a server log
	// into an unreadable query dump. "Record not found" is louder still and
	// it is not an error here: an unknown email at login and a non-member on
	// a permission check are both ordinary answers.
	gormLog := logger.New(log.New(os.Stderr, "", log.LstdFlags), logger.Config{
		LogLevel:                  logger.Warn,
		IgnoreRecordNotFoundError: true,
	})

	repo, err := repository.Open(cfg.DBPath, gormLog)
	if err != nil {
		log.Fatalf("could not open %s: %v", cfg.DBPath, err)
	}
	defer func() { _ = repo.Close() }()

	app := router.New(repo, cfg.SessionTTL)

	go func() {
		log.Printf("Revify API on %s (db: %s)", cfg.Addr, cfg.DBPath)
		if err := app.Listen(cfg.Addr); err != nil {
			log.Fatalf("server failed: %v", err)
		}
	}()

	// Finish in-flight requests before closing the database under them.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	log.Println("shutting down")
	if err := app.Shutdown(); err != nil {
		log.Printf("forced shutdown: %v", err)
	}
}
