package api

import (
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestLastExtensionContact(t *testing.T) {
	server := &Server{allowedExtensionID: DefaultExtensionID}
	require.True(t, server.LastExtensionContact().IsZero())
	request := httptest.NewRequest("GET", "/health", nil)
	server.noteExtensionFromRequest(request)
	require.True(t, server.LastExtensionContact().IsZero())
	request.Header.Set("Origin", extensionOriginPrefix+foreignExtensionID)
	server.noteExtensionFromRequest(request)
	require.True(t, server.LastExtensionContact().IsZero())
	request.Header.Set("Origin", extensionOriginPrefix+DefaultExtensionID)
	server.noteExtensionFromRequest(request)
	contact := server.LastExtensionContact()
	require.WithinDuration(t, time.Now(), contact, time.Second)
	server.noteExtension(DefaultExtensionID, "1.0")
	require.False(t, server.LastExtensionContact().Before(contact))
}
