package domain

import "testing"

func TestNormalizeCallURL(t *testing.T) {
	for _, tt := range []struct{ raw, want string }{
		{"https://meet.google.com/abc-defg-hij?authuser=0", "meet.google.com/abc-defg-hij"},
		{"https://telemost.yandex.ru/j/7201843355/", "telemost.yandex.ru/j/7201843355"},
		{" HTTPs://WWW.Example.COM/Room/ABC///?q=1#frag ", "example.com/Room/ABC"},
		{"meet.google.com/abc-defg-hij", "meet.google.com/abc-defg-hij"},
		{"//www.Example.com/", "example.com"},
		{"https://example.com/A%2Fb/", "example.com/A%2Fb"},
		{"https://example.com/Комната/", "example.com/Комната"},
		{"https://example.com/a%20b%2fc", "example.com/a%20b%2fc"},
		{"https://example.com:443/a", "example.com:443/a"},
		{"", ""}, {"not a url", ""}, {"broken", ""}, {"https://", ""},
		{"https://example.com/%zz", ""}, {"https://example.com:bad/", ""},
		{"ftp://example.com/a", ""}, {"https://user:pass@example.com/a", ""},
	} {
		t.Run(tt.raw, func(t *testing.T) {
			if got := NormalizeCallURL(tt.raw); got != tt.want {
				t.Fatalf("got %q, want %q", got, tt.want)
			}
		})
	}
}
