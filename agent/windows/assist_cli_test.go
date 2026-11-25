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

func TestNormalizePairingCode(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{"7acc5-c6a87", "7ACC5-C6A87"},
		{"chloe 7ACC5-C6A87", "7ACC5-C6A87"},
		{"  chloe assist 7acc5c6a87  ", "7ACC5-C6A87"},
		{"协助码：7ACC5-C6A87", "7ACC5-C6A87"},
	}
	for _, tc := range cases {
		if got := normalizePairingCode(tc.input); got != tc.want {
			t.Fatalf("normalizePairingCode(%q) = %q, want %q", tc.input, got, tc.want)
		}
	}
}
