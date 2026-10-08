package tools

type ListCallsInput struct {
	From        string `json:"from,omitempty" jsonschema:"Дата/время начала включительно; формат в описании"`
	To          string `json:"to,omitempty" jsonschema:"Дата включительно или дата-время исключительно"`
	Query       string `json:"query,omitempty" jsonschema:"Подстрока названия без учёта регистра и ё/е"`
	Participant string `json:"participant,omitempty" jsonschema:"Подстрока актуального имени участника"`
}

type GetSummaryInput struct {
	ID string `json:"id" jsonschema:"ID созвона из rechiv_list_calls"`
}

type GetTranscriptInput struct {
	ID     string `json:"id" jsonschema:"ID созвона"`
	From   string `json:"from,omitempty" jsonschema:"Начало сегмента от HH:MM:SS включительно"`
	To     string `json:"to,omitempty" jsonschema:"Конечный таймкод HH:MM:SS исключительно"`
	Offset int    `json:"offset,omitempty" jsonschema:"Индекс с нуля или next_offset; сохрани from/to"`
	Limit  int    `json:"limit,omitempty" jsonschema:"Размер страницы: 1–200; по умолчанию 200"`
}

type SearchInput struct {
	Query  string `json:"query" jsonschema:"Подстрока текста без учёта регистра; ё равно е"`
	ID     string `json:"id,omitempty" jsonschema:"ID созвона; без него поиск по всем готовым транскриптам"`
	Offset int    `json:"offset,omitempty" jsonschema:"Смещение среди совпадений с нуля или next_offset"`
	Limit  int    `json:"limit,omitempty" jsonschema:"Размер страницы: 1–200; по умолчанию 200"`
}
