package domain

const UnknownSpeakerID = "unknown"
const UnknownSpeakerName = "Неизвестный участник"

type VADParticipant struct {
	ParticipantID string `json:"participantId"`
	Name          string `json:"name"`
}

type VADEvent struct {
	At     float64  `json:"at"`
	Active []string `json:"active"`
}

// VADMicEvent сильнее запаздывающего VAD: замьюченный участник звучать не может.
type VADMicEvent struct {
	At      float64  `json:"at"`
	Unmuted []string `json:"unmuted"`
}

type VADTimeline struct {
	LocalParticipantID string           `json:"localParticipantId"`
	Participants       []VADParticipant `json:"participants"`
	Events             []VADEvent       `json:"events"`
	MicEvents          []VADMicEvent    `json:"micEvents,omitempty"`
}
