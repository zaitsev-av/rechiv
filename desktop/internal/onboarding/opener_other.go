//go:build !darwin

package onboarding

// xdg-open показывает каталог в файловом менеджере, а не выделяет его, как open -R.
const openCommand = "xdg-open"

func revealArgs(dir string) []string { return []string{dir} }
