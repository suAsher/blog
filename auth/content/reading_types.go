package content

import "encoding/json"

const maxReadingEntries = 10000
const maxReadingBytes = 4 << 20
const maxReadingOperations = 32
const maxReadingRequestBytes = 32 << 10
const maxReadingReceipts = 256
const maxSafeRevision int64 = 9007199254740991

type FieldRevisions struct {
	Bookmarked int64 `json:"bookmarked"`
	Read       int64 `json:"read"`
	Progress   int64 `json:"progress"`
	Review     int64 `json:"review"`
}
type ReadingReview struct {
	Enabled        bool    `json:"enabled"`
	Step           int     `json:"step"`
	DueAt          *string `json:"dueAt"`
	LastReviewedAt *string `json:"lastReviewedAt"`
}
type ReadingEntry struct {
	Bookmarked     bool           `json:"bookmarked"`
	Read           bool           `json:"read"`
	Progress       float64        `json:"progress"`
	UpdatedAt      int64          `json:"updatedAt"`
	FieldRevisions FieldRevisions `json:"fieldRevisions"`
	Review         *ReadingReview `json:"review,omitempty"`
}
type ReadingData struct {
	Revision int64                   `json:"revision"`
	Entries  map[string]ReadingEntry `json:"entries"`
}
type readingReceipt struct {
	OpID        string   `json:"opId"`
	Key         string   `json:"key"`
	Fingerprint string   `json:"fingerprint"`
	Applied     []string `json:"applied"`
	Conflicts   []string `json:"conflicts"`
}
type readingFile struct {
	SchemaVersion int                     `json:"schemaVersion"`
	Revision      int64                   `json:"revision"`
	Entries       map[string]ReadingEntry `json:"entries"`
	Receipts      []readingReceipt        `json:"receipts"`
}
type readingOperationWire struct {
	OpID  string                     `json:"opId"`
	Key   string                     `json:"key"`
	Base  map[string]json.RawMessage `json:"base"`
	Patch map[string]json.RawMessage `json:"patch"`
}
type readingOperation struct {
	OpID        string
	Key         string
	Base        map[string]int64
	Patch       map[string]json.RawMessage
	Fingerprint string
}
type ReadingResult struct {
	OpID      string       `json:"opId"`
	Key       string       `json:"key"`
	Applied   []string     `json:"applied"`
	Conflicts []string     `json:"conflicts"`
	Entry     ReadingEntry `json:"entry"`
	Replayed  bool         `json:"replayed,omitempty"`
}
type ReadingBatchData struct {
	Revision int64           `json:"revision"`
	Results  []ReadingResult `json:"results"`
}
type DueReview struct {
	Key   string `json:"key"`
	DueAt string `json:"dueAt"`
	Step  int    `json:"step"`
}
type ReviewsData struct {
	Due   []DueReview `json:"due"`
	Total int         `json:"total"`
}
