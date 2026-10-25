package main

import (
	"asher.space/auth/content"
	"log"
	"net/http"
	"os"
	"time"
)

func main() {
	path := os.Getenv("AUTH_CONFIG")
	if path == "" {
		path = "/run/auth/config.json"
	}
	c, err := loadCredentials(path)
	if err != nil {
		log.Fatal("authentication configuration is unavailable or invalid")
	}
	address := os.Getenv("AUTH_LISTEN")
	if address == "" {
		address = ":9090"
	}
	dataRoot := os.Getenv("AUTH_DATA_DIR")
	if dataRoot == "" {
		dataRoot = "/data/content"
	}
	store, err := content.NewStore(dataRoot)
	if err != nil {
		log.Fatal("document storage is unavailable; service refused to start")
	}
	handler := newAuthServer(c)
	handler.api = content.NewHandler(store)
	server := &http.Server{Addr: address, Handler: handler, ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout: 180 * time.Second, WriteTimeout: 180 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8192}
	log.Print("private document and session service ready")
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal("session service stopped")
	}
}
