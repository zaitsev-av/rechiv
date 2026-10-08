package controller

import (
	"strings"
	"unicode"
	"unicode/utf8"

	"rechiv/desktop/internal/domain"
)

const (
	mergeMaxGap    = 3.0
	mergeSoftLimit = 45.0
)

func mergeSegments(segments []domain.Segment, participants []*domain.Participant) []domain.Segment {
	if len(segments) < 2 {
		return segments
	}

	keep := collectCapitalized(segments, participants)
	merged := make([]domain.Segment, 0, len(segments))
	for _, segment := range segments {
		if len(merged) > 0 {
			last := &merged[len(merged)-1]
			if canMerge(last, &segment) {
				last.Text = joinText(last.Text, segment.Text, keep)
				if segment.EndSec > last.EndSec {
					last.EndSec = segment.EndSec
					last.End = segment.End
				}
				continue
			}
		}
		merged = append(merged, segment)
	}

	return merged
}

func canMerge(last, next *domain.Segment) bool {
	if last.Error || next.Error || last.SpeakerID != next.SpeakerID || last.SpeakerID == UnknownSpeakerID {
		return false
	}

	if next.StartSec-last.EndSec > mergeMaxGap {
		return false
	}

	return last.EndSec-last.StartSec < mergeSoftLimit || !endsSentence(last.Text)
}

func endsSentence(text string) bool {
	text = strings.TrimSpace(text)

	return strings.HasSuffix(text, ".") || strings.HasSuffix(text, "?") ||
		strings.HasSuffix(text, "!") || strings.HasSuffix(text, "…")
}

func joinText(previous, next string, keep capitalized) string {
	previous = strings.TrimSpace(previous)
	next = strings.TrimSpace(next)
	if previous == "" {
		return next
	}

	if next == "" {
		return previous
	}

	if !endsSentence(previous) {
		next = lowerFirst(next, keep)
	}

	return previous + " " + next
}

func lowerFirst(text string, keep capitalized) string {
	first, size := utf8.DecodeRuneInString(text)

	if !unicode.IsUpper(first) || !unicode.Is(unicode.Cyrillic, first) {
		return text
	}

	if second, _ := utf8.DecodeRuneInString(text[size:]); unicode.IsUpper(second) {
		return text
	}

	if keep.has(trimWord(strings.Fields(text)[0])) {
		return text
	}

	return string(unicode.ToLower(first)) + text[size:]
}

type capitalized struct {
	stems []string
	words map[string]bool
}

func (c capitalized) has(word string) bool {
	if c.words[word] {
		return true
	}
	for _, stem := range c.stems {
		if strings.HasPrefix(word, stem) {
			return true
		}
	}

	return false
}

func collectCapitalized(segments []domain.Segment, participants []*domain.Participant) capitalized {
	result := capitalized{words: make(map[string]bool)}
	for _, participant := range participants {
		for _, word := range strings.Fields(participant.Name) {
			if stem := nameStem(trimWord(word)); stem != "" {
				result.stems = append(result.stems, stem)
			}
		}
	}
	for _, item := range segments {
		fields := strings.Fields(item.Text)
		for index := 1; index < len(fields); index++ {
			if endsSentence(fields[index-1]) {
				continue
			}
			word := trimWord(fields[index])
			if first, _ := utf8.DecodeRuneInString(word); unicode.IsUpper(first) {
				result.words[word] = true
				if stem := nameStem(word); stem != "" {
					result.stems = append(result.stems, stem)
				}
			}
		}
	}
	return result
}

func nameStem(word string) string {
	runes := []rune(word)
	if len(runes) < 3 {
		return ""
	}

	if strings.ContainsRune("аеёиоуыэюяйь", unicode.ToLower(runes[len(runes)-1])) && len(runes) > 3 {
		runes = runes[:len(runes)-1]
	}

	return string(runes)
}

func trimWord(word string) string {
	return strings.TrimFunc(word, func(r rune) bool { return !unicode.IsLetter(r) })
}
