package main

import (
	"crypto/pbkdf2"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"strings"
)

type credentials struct {
	origin, username string
	salt, hash       []byte
	iterations       int
}

func loadCredentials(path string) (credentials, error) {
	invalid := errors.New("invalid authentication configuration")
	file, err := os.Open(path)
	if err != nil {
		return credentials{}, invalid
	}
	defer file.Close()
	var raw struct {
		Origin     string `json:"origin"`
		Username   string `json:"username"`
		Salt       string `json:"salt"`
		Hash       string `json:"password_hash"`
		Iterations int    `json:"iterations"`
	}
	decoder := json.NewDecoder(io.LimitReader(file, 8192))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&raw) != nil {
		return credentials{}, invalid
	}
	origin, err := url.Parse(raw.Origin)
	if err != nil || origin.Scheme != "https" || origin.Host == "" || origin.User != nil ||
		(origin.Path != "" && origin.Path != "/") || origin.RawQuery != "" || origin.Fragment != "" {
		return credentials{}, invalid
	}
	salt, saltErr := base64.StdEncoding.DecodeString(raw.Salt)
	hash, hashErr := base64.StdEncoding.DecodeString(raw.Hash)
	if saltErr != nil || hashErr != nil || len(salt) < 16 || len(salt) > 64 || len(hash) != 32 ||
		raw.Iterations < 600000 || raw.Iterations > 2000000 || len(raw.Username) == 0 ||
		len(raw.Username) > 128 || strings.ContainsAny(raw.Username, "\r\n:") {
		return credentials{}, invalid
	}
	return credentials{origin: origin.Scheme + "://" + origin.Host, username: raw.Username,
		salt: salt, hash: hash, iterations: raw.Iterations}, nil
}

func (c credentials) matches(username, password string) bool {
	hash, err := pbkdf2.Key(sha256.New, password, c.salt, c.iterations, 32)
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(hash, c.hash)&
		subtle.ConstantTimeCompare([]byte(username), []byte(c.username)) == 1
}

func safeNext(value string) string {
	if len(value) == 0 || len(value) > 2048 || !strings.HasPrefix(value, "/") || strings.HasPrefix(value, "//") {
		return "/"
	}
	decoded, err := url.PathUnescape(value)
	if err != nil || strings.HasPrefix(decoded, "//") || strings.ContainsAny(decoded, "\\\r\n\t\x00") {
		return "/"
	}
	u, err := url.Parse(value)
	if err != nil || u.Host != "" || u.Scheme != "" || strings.HasPrefix(u.Path, "/auth") || strings.HasPrefix(u.Path, "/login") {
		return "/"
	}
	return value
}
