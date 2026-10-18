package tools

import (
	"context"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	listCallsDescription = "Список созвонов по дате, названию, участнику и папке (folder; inbox — без папки). " +
		"Включает recording и processing со статусом; битые метаданные пропускаются. " +
		"Даты: YYYY-MM-DD или YYYY-MM-DDTHH:MM:SS с необязательным часовым поясом; " +
		"по умолчанию местное время. from включительно; to — дата включительно или дата-время исключительно."
	summaryDescription = "Markdown-саммари отдельно от транскрипта. " +
		"Если саммари нет, available=false; это не ошибка."
	transcriptDescription = "Строки [HH:MM:SS] Имя: текст. " +
		"Фильтр по таймкодам начала сегментов или страница по offset/limit; максимум 200 сегментов. " +
		"next_offset — индекс продолжения в полном транскрипте, total — всего сегментов. " +
		"При продолжении сохрани from/to. Незавершённый созвон возвращает ошибку."
	searchDescription = "Совпадения подстроки: call_id, call_title и created_at созвона, " +
		"timecode, speaker, text и segment_index. " +
		"Без id пропускает незавершённые и повреждённые транскрипты. " +
		"Для контекста запроси rechiv_get_transcript по call_id и segment_index."
)

func Register(server *mcp.Server, library CallLibrary) {
	addReadTool(
		server,
		"rechiv_list_calls",
		"Найти созвоны",
		listCallsDescription,
		func(ctx context.Context, in ListCallsInput) (*ListCallsOutput, error) {
			return listCalls(ctx, library, in)
		},
	)

	addReadTool(
		server,
		"rechiv_get_summary",
		"Прочитать саммари",
		summaryDescription,
		func(ctx context.Context, in GetSummaryInput) (*GetSummaryOutput, error) {
			return library.GetSummary(ctx, in.ID)
		},
	)

	addReadTool(
		server,
		"rechiv_get_transcript",
		"Прочитать фрагмент транскрипта",
		transcriptDescription,
		func(ctx context.Context, in GetTranscriptInput) (*GetTranscriptOutput, error) {
			return getTranscript(ctx, library, in)
		},
	)

	addReadTool(
		server,
		"rechiv_search",
		"Поиск по транскриптам",
		searchDescription,
		func(ctx context.Context, in SearchInput) (*SearchOutput, error) {
			return search(ctx, library, in)
		},
	)
}
