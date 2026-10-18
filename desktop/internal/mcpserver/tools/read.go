//go:generate go tool mockgen -source=read.go -destination=mocks/read.go -package=mocks
package tools

import (
	"context"
	"encoding/json"
	"fmt"

	"rechiv/desktop/internal/library"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type CallLibrary interface {
	ListCalls(context.Context, library.ListFilter) ([]library.Call, error)
	GetSummary(context.Context, string) (*library.Summary, error)
	GetTranscript(context.Context, string, library.TranscriptFilter) (*library.TranscriptPage, error)
	Search(context.Context, library.SearchFilter) (*library.SearchPage, error)
}

func listCalls(ctx context.Context, client CallLibrary, in ListCallsInput) (*ListCallsOutput, error) {
	calls, err := client.ListCalls(ctx, library.ListFilter{
		Folder:      in.Folder,
		From:        in.From,
		To:          in.To,
		Query:       in.Query,
		Participant: in.Participant,
	})
	if err != nil {
		return nil, err
	}
	if calls == nil {
		calls = []library.Call{}
	}
	return &ListCallsOutput{Calls: calls}, nil
}

func getTranscript(
	ctx context.Context,
	client CallLibrary,
	in GetTranscriptInput,
) (*GetTranscriptOutput, error) {
	return client.GetTranscript(ctx, in.ID, library.TranscriptFilter{
		From:   in.From,
		To:     in.To,
		Offset: in.Offset,
		Limit:  in.Limit,
	})
}

func search(ctx context.Context, client CallLibrary, in SearchInput) (*SearchOutput, error) {
	return client.Search(ctx, library.SearchFilter{
		ID:     in.ID,
		Query:  in.Query,
		Offset: in.Offset,
		Limit:  in.Limit,
	})
}

func addReadTool[In, Out any](
	server *mcp.Server,
	name, title, description string,
	read func(context.Context, In) (*Out, error),
) {
	schema, err := jsonschema.For[Out](nil)
	if err != nil {
		panic(fmt.Errorf("создать схему результата: %w", err))
	}
	mcp.AddTool(server, &mcp.Tool{
		Name:         name,
		Title:        title,
		Description:  description,
		OutputSchema: schema,
		Annotations:  &mcp.ToolAnnotations{ReadOnlyHint: true},
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in In) (*mcp.CallToolResult, any, error) {
		out, err := read(ctx, in)
		if err != nil {
			return toolError(err), nil, nil
		}
		if out == nil {
			return toolError(fmt.Errorf("пустой ответ библиотеки")), nil, nil
		}
		data, err := json.Marshal(out)
		if err != nil {
			return toolError(fmt.Errorf("сериализовать результат: %w", err)), nil, nil
		}
		return &mcp.CallToolResult{
			StructuredContent: json.RawMessage(data),
			Content:           []mcp.Content{&mcp.TextContent{Text: string(data)}},
		}, nil, nil
	})
}

func toolError(err error) *mcp.CallToolResult {
	return &mcp.CallToolResult{
		IsError: true,
		Content: []mcp.Content{&mcp.TextContent{Text: err.Error()}},
	}
}
