package api

import (
	"encoding/json"
	"os"
	"slices"
	"testing"
)

func TestAllowedPageOriginsMatchPlatformRegistry(t *testing.T) {
	data, err := os.ReadFile("../../../extension/src/platforms.json")
	if err != nil {
		t.Fatal(err)
	}
	var platforms []struct {
		Hosts []string `json:"hosts"`
	}
	if err := json.Unmarshal(data, &platforms); err != nil {
		t.Fatal(err)
	}
	var expected []string
	for _, platform := range platforms {
		for _, host := range platform.Hosts {
			expected = append(expected, "https://"+host)
		}
	}
	actual := slices.Clone(allowedPageOrigins)
	slices.Sort(expected)
	slices.Sort(actual)
	if len(expected) == 0 || !slices.Equal(actual, expected) {
		t.Fatalf("allowedPageOrigins = %v, platform origins = %v", actual, expected)
	}
}
