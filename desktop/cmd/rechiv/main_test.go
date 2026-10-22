package main

import "testing"

func TestPageBaseURL(t *testing.T) {
	for listen, want := range map[string]string{
		"127.0.0.1:9876":   "http://rechiv.localhost:9876",
		"localhost:9900":   "http://rechiv.localhost:9900",
		"[::1]:9876":       "http://rechiv.localhost:9876",
		":9876":            "http://rechiv.localhost:9876",
		"192.168.1.5:9876": "http://192.168.1.5:9876",
	} {
		if got := pageBaseURL(listen); got != want {
			t.Errorf("pageBaseURL(%q) = %q, want %q", listen, got, want)
		}
	}
}
