package mcpserver

import (
	"encoding/json"
	"testing"

	"rechiv/desktop/internal/library"
	"rechiv/desktop/internal/mcpserver/tools/mocks"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"
)

func TestNewServerContract(t *testing.T) {
	is := require.New(t)
	calls := mocks.NewMockCallLibrary(gomock.NewController(t))
	calls.EXPECT().ListCalls(gomock.Any(), library.ListFilter{}).Return([]library.Call{}, nil)
	server := NewServer(DefaultConfig("1.2.3"), calls)
	ct, st := mcp.NewInMemoryTransports()
	ss, err := server.Connect(t.Context(), st, nil)
	is.NoError(err)
	client := mcp.NewClient(&mcp.Implementation{
		Name:    "test",
		Version: "test",
	}, nil)
	cs, err := client.Connect(t.Context(), ct, nil)
	is.NoError(err)
	t.Cleanup(func() {
		is.NoError(cs.Close())
		is.NoError(ss.Wait())
	})
	is.Equal("rechiv", cs.InitializeResult().ServerInfo.Name)
	is.Equal("1.2.3", cs.InitializeResult().ServerInfo.Version)
	is.Equal(instructions, cs.InitializeResult().Instructions)
	listed, err := cs.ListTools(t.Context(), nil)
	is.NoError(err)
	is.Len(listed.Tools, 4)
	names := make([]string, 0, len(listed.Tools))
	for _, tool := range listed.Tools {
		names = append(names, tool.Name)
		is.True(tool.Annotations.ReadOnlyHint)
		is.NotNil(tool.OutputSchema)
		input, err := json.Marshal(tool.InputSchema)
		is.NoError(err)
		switch tool.Name {
		case "rechiv_get_summary", "rechiv_get_transcript":
			is.Contains(string(input), `"required":["id"]`)
		case "rechiv_search":
			is.Contains(string(input), `"required":["query"]`)
		}
	}
	is.ElementsMatch([]string{
		"rechiv_list_calls",
		"rechiv_get_summary",
		"rechiv_get_transcript",
		"rechiv_search",
	}, names)
	out, err := cs.CallTool(t.Context(), &mcp.CallToolParams{
		Name:      "rechiv_list_calls",
		Arguments: map[string]any{},
	})
	is.NoError(err)
	is.False(out.IsError)
	data, err := json.Marshal(out.StructuredContent)
	is.NoError(err)
	is.JSONEq(`{"calls":[]}`, string(data))
	is.JSONEq(string(data), out.Content[0].(*mcp.TextContent).Text)
}
