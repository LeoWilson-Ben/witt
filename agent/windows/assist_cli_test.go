package main

import (
	"testing"
)

func TestAssistClientValidation(t *testing.T) {
	if _, err := newAssistClient(assistOptions{Server: "http://example.com/vault-api"}); err == nil {
		t.Fatalf("expected non-loopback http server rejected")
	}
	if _, err := newAssistClient(assistOptions{Server: "http://127.0.0.1:3003"}); err != nil {
		t.Fatalf("expected loopback http server allowed: %v", err)
	}
	if _, err := newAssistClient(assistOptions{Server: "https://13-208-127-58.sslip.io/vault-api"}); err != nil {
		t.Fatalf("expected https server allowed: %v", err)
	}
}
