package content

const (
	MaxUploadBytes int64 = 32 << 20
	MaxImageBytes  int64 = 8 << 20
	MaxSourceBytes int64 = 2 << 20
	ReserveBytes   int64 = 64 << 20
)

type Content struct {
	Title       string   `json:"title" yaml:"title"`
	Description string   `json:"description" yaml:"description"`
	Date        string   `json:"date" yaml:"date"`
	Tags        []string `json:"tags" yaml:"tags"`
	Category    string   `json:"category" yaml:"category,omitempty"`
	Cover       string   `json:"cover" yaml:"cover,omitempty"`
	Source      string   `json:"source" yaml:"-"`
	Kind        string   `json:"kind,omitempty" yaml:"kind,omitempty"`
	Maturity    string   `json:"maturity,omitempty" yaml:"maturity,omitempty"`
	Series      string   `json:"series,omitempty" yaml:"series,omitempty"`
	Related     []string `json:"related,omitempty" yaml:"related,omitempty"`
}

type Summary struct {
	ID                    string   `json:"id"`
	Title                 string   `json:"title"`
	Description           string   `json:"description"`
	Date                  string   `json:"date"`
	Tags                  []string `json:"tags"`
	Category              string   `json:"category"`
	Cover                 string   `json:"cover"`
	ReadingMinutes        int      `json:"readingMinutes"`
	Demo                  bool     `json:"demo"`
	Body                  string   `json:"body"`
	Status                string   `json:"status"`
	Version               int      `json:"version"`
	CreatedAt             string   `json:"createdAt"`
	UpdatedAt             string   `json:"updatedAt"`
	PublishedAt           string   `json:"publishedAt,omitempty"`
	HasUnpublishedChanges bool     `json:"hasUnpublishedChanges"`
	Kind                  string   `json:"kind"`
	Maturity              string   `json:"maturity"`
	Series                string   `json:"series"`
	Related               []string `json:"related"`
}
type Heading struct {
	Depth int    `json:"depth"`
	Slug  string `json:"slug"`
	Text  string `json:"text"`
}
type Detail struct {
	Summary
	Source     string    `json:"source"`
	HTML       string    `json:"html"`
	Headings   []Heading `json:"headings"`
	SourcePath string    `json:"sourcePath,omitempty"`
}
type Quota struct {
	UsedBytes      int64 `json:"usedBytes"`
	FreeBytes      int64 `json:"freeBytes"`
	ReserveBytes   int64 `json:"reserveBytes"`
	MaxUploadBytes int64 `json:"maxUploadBytes"`
	MaxImageBytes  int64 `json:"maxImageBytes"`
	MaxSourceBytes int64 `json:"maxSourceBytes"`
}
type Facet struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}
type Stats struct {
	Draft     int `json:"draft"`
	Published int `json:"published"`
	Trash     int `json:"trash"`
}
type ListData struct {
	Documents  []Summary `json:"documents"`
	Total      int       `json:"total"`
	Tags       []Facet   `json:"tags"`
	Categories []Facet   `json:"categories"`
	Stats      Stats     `json:"stats"`
	Quota      Quota     `json:"quota"`
}
type ListOptions struct {
	Status, Query, Tag, Category string
	Limit, Offset                int
}
type record struct {
	ID                    string            `json:"id"`
	Version               int               `json:"version"`
	Status                string            `json:"status"`
	Working               Content           `json:"working"`
	Published             *Content          `json:"published,omitempty"`
	CreatedAt             string            `json:"createdAt"`
	UpdatedAt             string            `json:"updatedAt"`
	PublishedAt           string            `json:"publishedAt,omitempty"`
	SourcePath            string            `json:"sourcePath,omitempty"`
	Aliases               map[string]string `json:"aliases,omitempty"`
	Activity              []activityBucket  `json:"activity,omitempty"`
	WorkingTitleAliases   []string          `json:"workingTitleAliases,omitempty"`
	PublishedTitleAliases []string          `json:"publishedTitleAliases,omitempty"`
}
type apiError struct {
	Status        int
	Code, Message string
}

func (e *apiError) Error() string          { return e.Message }
func bad(status int, message string) error { return &apiError{Status: status, Message: message} }
