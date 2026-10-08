package domain

import (
	"fmt"
	"sort"
	"strings"
)

func ApplySpeakerNames(
	session *Session,
	timeline *VADTimeline,
	transcript *Transcript,
) {
	if timeline == nil {
		names, participants := ResolveSpeakers(session)
		if len(participants) > 0 {
			transcript.Participants = participants
		}
		for i := range transcript.Segments {
			if name, ok := names[transcript.Segments[i].SpeakerID]; ok {
				transcript.Segments[i].Speaker = name
			}
		}
		return
	}

	unknownUsed := false
	for _, segment := range transcript.Segments {
		if segment.SpeakerID == UnknownSpeakerID {
			unknownUsed = true
			break
		}
	}
	names, participants := ResolveVADSpeakers(session, timeline, unknownUsed)
	if len(participants) > 0 {
		transcript.Participants = participants
	}
	for i := range transcript.Segments {
		if name, ok := names[transcript.Segments[i].SpeakerID]; ok {
			transcript.Segments[i].Speaker = name
		}
	}
}

func ResolveSpeakers(session *Session) (map[string]string, []*Participant) {
	registry := make(map[string]string, len(session.Participants))
	for speakerID, participant := range session.Participants {
		registry[speakerID] = participant.Name
	}
	return resolveSpeakerRegistry(registry)
}

func ResolveVADSpeakers(
	session *Session,
	timeline *VADTimeline,
	includeUnknown bool,
) (map[string]string, []*Participant) {
	registry := make(map[string]string, len(timeline.Participants)+2)
	localName := ""
	if participant := session.Participants["local"]; participant != nil {
		localName = participant.Name
	}
	for _, participant := range timeline.Participants {
		if participant.ParticipantID == "" {
			continue
		}
		name := participant.Name
		if renamed := session.Participants[participant.ParticipantID]; renamed != nil &&
			strings.TrimSpace(renamed.Name) != "" {
			name = renamed.Name
		}
		if participant.ParticipantID == timeline.LocalParticipantID {
			if strings.TrimSpace(localName) == "" {
				localName = name
			}
			continue
		}
		registry[participant.ParticipantID] = name
	}
	registry["local"] = localName
	if includeUnknown {
		registry[UnknownSpeakerID] = UnknownSpeakerName
	}
	return resolveSpeakerRegistry(registry)
}

// Безымянные нумеруются по speakerID, чтобы порядок реплик не менял имена.
func resolveSpeakerRegistry(registry map[string]string) (map[string]string, []*Participant) {
	participants := make([]*Participant, 0, len(registry))
	names := make(map[string]string, len(registry))
	unnamed := 0
	speakerIDs := make([]string, 0, len(registry))
	for speakerID := range registry {
		speakerIDs = append(speakerIDs, speakerID)
	}
	sort.Strings(speakerIDs)
	for _, speakerID := range speakerIDs {
		name := strings.TrimSpace(registry[speakerID])
		if name == "" {
			unnamed++
			name = fmt.Sprintf("Спикер %d", unnamed)
		}
		names[speakerID] = name
		participants = append(participants, &Participant{
			SpeakerID: speakerID,
			Name:      name,
		})
	}
	return names, participants
}
