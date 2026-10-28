package content

const (
	maxResearchBytes       = 16 << 20
	maxAnnotations         = 1000
	maxDocumentAnnotations = 200
	maxWorkspaces          = 50
)

type TextQuote struct {
	Exact  string `json:"exact"`
	Prefix string `json:"prefix"`
	Suffix string `json:"suffix"`
}
type Annotation struct {
	ID         string    `json:"id"`
	DocumentID string    `json:"documentId"`
	Quote      TextQuote `json:"quote"`
	Body       string    `json:"body"`
	Color      string    `json:"color"`
	Version    int64     `json:"version"`
	CreatedAt  string    `json:"createdAt"`
	UpdatedAt  string    `json:"updatedAt"`
}
type WorkspaceQuestion struct {
	ID   string `json:"id"`
	Text string `json:"text"`
	Done bool   `json:"done"`
}
type WorkspacePosition struct {
	ID string  `json:"id"`
	X  float64 `json:"x"`
	Y  float64 `json:"y"`
}
type Workspace struct {
	ID          string              `json:"id"`
	Title       string              `json:"title"`
	Description string              `json:"description"`
	DocumentIDs []string            `json:"documentIds"`
	Questions   []WorkspaceQuestion `json:"questions"`
	Positions   []WorkspacePosition `json:"positions"`
	Version     int64               `json:"version"`
	CreatedAt   string              `json:"createdAt"`
	UpdatedAt   string              `json:"updatedAt"`
}
type researchFile struct {
	SchemaVersion int                   `json:"schemaVersion"`
	Annotations   map[string]Annotation `json:"annotations"`
	Workspaces    map[string]Workspace  `json:"workspaces"`
}
type annotationRequest struct {
	DocumentID string     `json:"documentId"`
	Quote      *TextQuote `json:"quote"`
	Body       *string    `json:"body"`
	Color      string     `json:"color,omitempty"`
}
type annotationUpdate struct {
	Version int64   `json:"version"`
	Body    *string `json:"body"`
	Color   string  `json:"color,omitempty"`
}
type workspaceRequest struct {
	Title       string              `json:"title"`
	Description string              `json:"description"`
	DocumentIDs []string            `json:"documentIds"`
	Questions   []WorkspaceQuestion `json:"questions"`
	Positions   []WorkspacePosition `json:"positions,omitempty"`
	Version     int64               `json:"version,omitempty"`
}
