package content

import (
	"strings"
	"unicode/utf8"
)

const maxStructuredLines = 10000
const maxStructureMarkers = 20000
const maxQuoteDepth = 32

// Bound parser work before building a Goldmark AST. Long plain text and fenced
// code remain valid; a short but structurally extreme document gets a useful
// error instead of repeatedly exhausting a small personal-server container.
func validateSource(source string) error {
	if !utf8.ValidString(source) || strings.IndexFunc(source, func(r rune) bool {
		return r < 32 && r != '\n' && r != '\r' && r != '\t'
	}) >= 0 || int64(len(source)) > MaxSourceBytes {
		return bad(400, "正文必须为有效 UTF-8 文本，且不超过 2 MB。")
	}
	tooDense := func() error {
		return bad(400, "文档结构过于密集，请拆分为多篇，或将长代码放入围栏代码块后重试。")
	}
	lines, markers := 0, 0
	var fence byte
	fenceLength := 0
	var rawHTML htmlBudgetState
	for {
		line, remainder, more := strings.Cut(source, "\n")
		character, length, tail := fenceLine(line)
		blockedFence := false
		if fence == 0 {
			blockedFence = rawHTML.blocksFence(line)
		}
		if fence != 0 {
			if character == fence && length >= fenceLength && strings.TrimSpace(tail) == "" {
				fence = 0
			}
		} else if !blockedFence && length >= 3 && (character != '`' || !strings.ContainsRune(tail, '`')) {
			fence, fenceLength = character, length
		} else {
			lines++
			if lines > maxStructuredLines {
				return tooDense()
			}
			quoted := strings.TrimLeft(line, " \t")
			for depth := 0; strings.HasPrefix(quoted, ">"); {
				depth++
				if depth > maxQuoteDepth {
					return tooDense()
				}
				quoted = strings.TrimLeft(quoted[1:], " \t")
			}
			for i := 0; i < len(line); i++ {
				switch line[i] {
				case '*', '_', '[', ']', '|', '`', '!':
					markers++
				case '<':
					// Actual tags/autolinks can create many inline nodes. Literal
					// comparison operators such as repeated '<>&' stay plain text.
					if i+1 < len(line) {
						next := line[i+1]
						if next >= 'a' && next <= 'z' || next >= 'A' && next <= 'Z' || next == '/' || next == '!' || next == '?' {
							markers++
						}
					}
				}
				if markers > maxStructureMarkers {
					return tooDense()
				}
			}
		}
		if !more {
			break
		}
		source = remainder
	}
	return nil
}

// A code-fence-looking line inside raw HTML is not a Markdown fence. Tracking
// these blocks prevents a comment/tag from hiding expensive following syntax.
type htmlBudgetState struct {
	terminator string
	untilBlank bool
}

func (s *htmlBudgetState) blocksFence(line string) bool {
	trimmed := strings.TrimSpace(line)
	if s.terminator != "" {
		if strings.Contains(strings.ToLower(line), s.terminator) {
			s.terminator = ""
		}
		return true
	}
	if s.untilBlank {
		if trimmed != "" {
			return true
		}
		s.untilBlank = false
	}
	if len(trimmed) < 2 || trimmed[0] != '<' {
		return false
	}
	next := trimmed[1]
	if !(next >= 'a' && next <= 'z' || next >= 'A' && next <= 'Z' || next == '/' || next == '!' || next == '?') {
		return false
	}
	lower := strings.ToLower(trimmed)
	end := ""
	switch {
	case strings.HasPrefix(lower, "<!--"):
		end = "-->"
	case strings.HasPrefix(lower, "<![cdata["):
		end = "]]>"
	case strings.HasPrefix(lower, "<?"):
		end = "?>"
	case strings.HasPrefix(lower, "<!"):
		end = ">"
	default:
		for _, tag := range []string{"script", "style", "pre", "textarea"} {
			prefix := "<" + tag
			if strings.HasPrefix(lower, prefix) && (len(lower) == len(prefix) || strings.ContainsRune(" \t\r>/", rune(lower[len(prefix)]))) {
				end = "</" + tag + ">"
				break
			}
		}
	}
	if end != "" {
		if !strings.Contains(lower, end) {
			s.terminator = end
		}
	} else {
		s.untilBlank = true
	}
	return true
}

func fenceLine(line string) (byte, int, string) {
	i := 0
	for i < len(line) && line[i] == ' ' {
		i++
	}
	if i > 3 || i == len(line) || line[i] != '`' && line[i] != '~' {
		return 0, 0, ""
	}
	character, start := line[i], i
	for i < len(line) && line[i] == character {
		i++
	}
	if i-start < 3 {
		return 0, 0, ""
	}
	return character, i - start, line[i:]
}
