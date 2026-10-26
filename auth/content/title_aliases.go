package content

import "strings"

const maxTitleAliases = 32
const maxTitleAliasBytes = 8 << 10

// Histories are separate from image-path aliases and from each other. Only a
// formerly published title enters the published history; interim draft names
// never become searchable in the published view.
func rememberTitle(previous []string, title string) []string {
	title = strings.TrimSpace(title)
	result := []string{}
	for _, alias := range previous {
		if normalized(alias) != normalized(title) {
			result = append(result, alias)
		}
	}
	if title != "" {
		result = append(result, title)
	}
	for len(result) > maxTitleAliases || titleAliasBytes(result) > maxTitleAliasBytes {
		result = append([]string{}, result[1:]...)
	}
	return result
}

func titleAliasBytes(aliases []string) int {
	total := 0
	for _, alias := range aliases {
		total += len(alias) + 16
	}
	return total
}
