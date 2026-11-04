//go:build darwin

package onboarding

const openCommand = "/usr/bin/open"

func revealArgs(dir string) []string { return []string{"-R", dir} }
