package controller

import (
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"slices"
	"sort"

	"rechiv/desktop/internal/domain"
)

const UnknownSpeakerID = domain.UnknownSpeakerID
const UnknownSpeakerName = domain.UnknownSpeakerName

// VAD запаздывает из-за debounceTimeMs=5000: нужны запасное окно и перевес лидера,
// а не доля покрытия. Пороги проверены на двух участниках; ложное имя хуже пропуска.
const (
	vadGuard    = 1.5
	vadLeadOver = 2.0
)

var ErrInvalidVADTimeline = errors.New("invalid VAD timeline")

type VADParticipant = domain.VADParticipant
type VADEvent = domain.VADEvent
type VADMicEvent = domain.VADMicEvent
type VADTimeline = domain.VADTimeline

func (c *Controller) VADPath(sessionID string) string {
	return filepath.Join(c.store.SessionDir(sessionID), "vad.json")
}

func (c *Controller) SaveVADTimeline(sessionID string, timeline VADTimeline) error {
	if _, err := c.store.Get(sessionID); err != nil {
		return err
	}

	for _, event := range timeline.Events {
		if event.At < 0 || math.IsNaN(event.At) || math.IsInf(event.At, 0) {
			return fmt.Errorf("%w: at должен быть неотрицательным числом", ErrInvalidVADTimeline)
		}
	}

	for _, event := range timeline.MicEvents {
		if event.At < 0 || math.IsNaN(event.At) || math.IsInf(event.At, 0) {
			return fmt.Errorf("%w: at должен быть неотрицательным числом", ErrInvalidVADTimeline)
		}
	}

	normalized := timeline
	normalized.Events = append([]VADEvent(nil), timeline.Events...)
	sort.SliceStable(normalized.Events, func(i, j int) bool {
		return normalized.Events[i].At < normalized.Events[j].At
	})

	normalized.MicEvents = append([]VADMicEvent(nil), timeline.MicEvents...)
	sort.SliceStable(normalized.MicEvents, func(i, j int) bool {
		return normalized.MicEvents[i].At < normalized.MicEvents[j].At
	})

	return WriteJSON(c.VADPath(sessionID), normalized)
}

func (c *Controller) readVADTimeline(sessionID string) (*VADTimeline, error) {
	var timeline VADTimeline
	if err := ReadJSON(c.VADPath(sessionID), &timeline); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}

	return &timeline, nil
}

func attributeVADSpeaker(
	start, end float64,
	timeline *VADTimeline,
	knownParticipants map[string]string,
) (string, bool) {
	if end-start <= 0 {
		return "", false
	}

	candidates := unmutedDuring(start, end, timeline, knownParticipants)
	if candidates != nil {
		for participantID := range heardWhileMuted(start, end, timeline, knownParticipants) {
			candidates[participantID] = struct{}{}
		}
	}

	if len(candidates) == 1 {
		for participantID := range candidates {
			return participantID, true
		}
	}

	if id, ok := dominantParticipant(start, end, timeline, knownParticipants, candidates); ok {
		return id, true
	}

	return dominantParticipant(
		max(0, start-vadGuard),
		end+vadGuard,
		timeline,
		knownParticipants,
		candidates,
	)
}

func unmutedDuring(
	start, end float64,
	timeline *VADTimeline,
	knownParticipants map[string]string,
) map[string]struct{} {
	if len(timeline.MicEvents) == 0 {
		return nil
	}

	result := make(map[string]struct{})
	for index, event := range timeline.MicEvents {
		if event.At >= end {
			break
		}

		if index+1 < len(timeline.MicEvents) && timeline.MicEvents[index+1].At <= start {
			continue
		}

		for _, participantID := range event.Unmuted {
			if participantID == timeline.LocalParticipantID {
				continue
			}
			if _, known := knownParticipants[participantID]; !known {
				continue
			}
			result[participantID] = struct{}{}
		}
	}

	return result
}

func heardWhileMuted(
	start, end float64,
	timeline *VADTimeline,
	knownParticipants map[string]string,
) map[string]struct{} {
	result := make(map[string]struct{})
	heard := make(map[string]struct{})
	var previous map[string]struct{}
	for index, event := range timeline.Events {
		if event.At >= end {
			break
		}
		current := make(map[string]struct{}, len(event.Active))
		for _, participantID := range event.Active {
			current[participantID] = struct{}{}
		}
		for participantID := range heard {
			if _, active := current[participantID]; !active {
				delete(heard, participantID)
			}
		}

		if previous != nil {
			for participantID := range current {
				if _, was := previous[participantID]; !was && mutedAt(participantID, event.At, timeline) {
					heard[participantID] = struct{}{}
				}
			}
		}
		previous = current

		if index+1 < len(timeline.Events) && timeline.Events[index+1].At <= start {
			continue
		}

		for participantID := range heard {
			if participantID == timeline.LocalParticipantID {
				continue
			}
			if _, known := knownParticipants[participantID]; !known {
				continue
			}
			result[participantID] = struct{}{}
		}
	}

	return result
}

func mutedAt(participantID string, at float64, timeline *VADTimeline) bool {
	known := false
	muted := false
	for _, event := range timeline.MicEvents {
		if event.At > at {
			break
		}
		known = true
		muted = !slices.Contains(event.Unmuted, participantID)
	}

	return known && muted
}

func dominantParticipant(
	start, end float64,
	timeline *VADTimeline,
	knownParticipants map[string]string,
	candidates map[string]struct{},
) (string, bool) {
	coverage := make(map[string]float64)
	for index, event := range timeline.Events {
		if event.At >= end {
			break
		}
		stateEnd := end
		if index+1 < len(timeline.Events) && timeline.Events[index+1].At < stateEnd {
			stateEnd = timeline.Events[index+1].At
		}
		overlapStart := max(start, event.At)
		if stateEnd <= overlapStart {
			continue
		}
		seen := make(map[string]struct{}, len(event.Active))
		for _, participantID := range event.Active {
			if participantID == timeline.LocalParticipantID {
				continue
			}

			if _, known := knownParticipants[participantID]; !known {
				continue
			}

			if candidates != nil {
				if _, allowed := candidates[participantID]; !allowed {
					continue
				}
			}
			if _, duplicate := seen[participantID]; duplicate {
				continue
			}

			seen[participantID] = struct{}{}
			coverage[participantID] += stateEnd - overlapStart
		}
	}

	topID := ""
	topCoverage := 0.0
	secondCoverage := 0.0
	for participantID, covered := range coverage {
		if covered > topCoverage {
			secondCoverage = topCoverage
			topID = participantID
			topCoverage = covered
		} else if covered > secondCoverage {
			secondCoverage = covered
		}
	}

	if topCoverage <= 0 {
		return "", false
	}

	if secondCoverage > 0 && topCoverage < vadLeadOver*secondCoverage {
		return "", false
	}

	return topID, true
}
