package main

import (
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"

	"github.com/DotNaos/project-space/internal/roadmap"
	"github.com/mattn/go-runewidth"
)

const fallbackRoadmapOutputWidth = 100

var (
	markdownImagePattern = regexp.MustCompile(`!\[([^\]]*)\]\([^)]+\)`)
	markdownLinkPattern  = regexp.MustCompile(`\[([^\]]+)\]\([^)]+\)`)
	markdownPrefix       = regexp.MustCompile(`(?m)^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s*`)
	markdownTagPattern   = regexp.MustCompile(`<[^>]+>`)
	whitespacePattern    = regexp.MustCompile(`\s+`)
)

func writeRoadmapGraph(
	output io.Writer,
	graph roadmap.Graph,
	format string,
	verbose bool,
	width int,
) error {
	if format == "json" {
		encoder := json.NewEncoder(output)
		encoder.SetIndent("", "  ")
		return encoder.Encode(graph)
	}
	if len(graph.Paths) == 0 {
		_, err := fmt.Fprintln(output, "No roadmap issues.")
		return err
	}
	nodes := make(map[string]roadmap.Node, len(graph.Nodes))
	for _, node := range graph.Nodes {
		nodes[roadmapReferenceKey(node.NodeReference)] = node
	}
	edges := make(map[string]roadmap.Edge, len(graph.Edges))
	for _, edge := range graph.Edges {
		edges[roadmapEdgeKey(edge.From, edge.To)] = edge
	}
	for pathIndex, path := range graph.Paths {
		if verbose && pathIndex > 0 {
			if _, err := fmt.Fprintln(output); err != nil {
				return err
			}
		}
		if err := writeRoadmapPath(output, graph, path, nodes, edges, verbose, width); err != nil {
			return err
		}
	}
	return nil
}

func writeRoadmapPath(
	output io.Writer,
	graph roadmap.Graph,
	path []roadmap.NodeReference,
	nodes map[string]roadmap.Node,
	edges map[string]roadmap.Edge,
	verbose bool,
	width int,
) error {
	var line strings.Builder
	for index, reference := range path {
		node, found := nodes[roadmapReferenceKey(reference)]
		if !found {
			return roadmap.ErrInvalidResponse
		}
		arrow := ""
		if index > 0 {
			edge, edgeFound := edges[roadmapEdgeKey(path[index-1], reference)]
			if !edgeFound {
				return roadmap.ErrInvalidResponse
			}
			if edge.Satisfied {
				arrow = " -> "
			} else {
				arrow = " -[BLOCKS]-> "
			}
		}
		label := roadmapNodeToken(node, graph.Repository)
		if verbose {
			prefix := strings.TrimSpace(arrow)
			if index > 0 {
				prefix = "  " + prefix + " "
			}
			if _, err := fmt.Fprintln(
				output,
				prefix+label+" "+roadmapNodeDetail(
					node,
					width-runewidth.StringWidth(prefix+label)-1,
				),
			); err != nil {
				return err
			}
			continue
		}
		line.WriteString(arrow)
		line.WriteString(label)
	}
	if verbose {
		return nil
	}
	_, err := fmt.Fprintln(output, line.String())
	return err
}

func roadmapNodeToken(node roadmap.Node, localRepository string) string {
	return roadmapIssueLabel(node.Repository, node.Number, localRepository) +
		"[" + string(node.State) + "]"
}

func roadmapNodeDetail(node roadmap.Node, width int) string {
	title := normalizedRoadmapText(node.Title)
	if title == "" {
		title = "Untitled issue"
	}
	description := normalizedRoadmapDescription(node.Description)
	const separator = " — "
	available := max(8, width-runewidth.StringWidth(separator))
	titleWidth := min(runewidth.StringWidth(title), max(4, available/2))
	descriptionWidth := max(4, available-titleWidth)
	return truncateRoadmapText(title, titleWidth) +
		separator +
		truncateRoadmapText(description, descriptionWidth)
}

func normalizedRoadmapDescription(value string) string {
	normalized := normalizedRoadmapText(value)
	if normalized == "" {
		return "No description."
	}
	return normalized
}

func normalizedRoadmapText(value string) string {
	value = strings.ReplaceAll(value, "\r\n", "\n")
	value = strings.ReplaceAll(value, "\r", "\n")
	value = markdownImagePattern.ReplaceAllString(value, "$1")
	value = markdownLinkPattern.ReplaceAllString(value, "$1")
	value = markdownPrefix.ReplaceAllString(value, "")
	value = markdownTagPattern.ReplaceAllString(value, " ")
	value = strings.NewReplacer(
		"```", " ",
		"`", "",
		"**", "",
		"__", "",
		"~~", "",
	).Replace(value)
	return strings.TrimSpace(whitespacePattern.ReplaceAllString(value, " "))
}

func truncateRoadmapText(value string, width int) string {
	if runewidth.StringWidth(value) <= width {
		return value
	}
	if width <= 1 {
		return "…"
	}
	return strings.TrimSpace(runewidth.Truncate(value, width, "…"))
}

func roadmapIssueLabel(repository string, number int, localRepository string) string {
	if strings.EqualFold(repository, localRepository) {
		return "#" + strconv.Itoa(number)
	}
	return repository + "#" + strconv.Itoa(number)
}

func roadmapReferenceKey(reference roadmap.NodeReference) string {
	return strings.ToLower(reference.Repository) + "#" + strconv.Itoa(reference.Number)
}

func roadmapEdgeKey(from roadmap.NodeReference, to roadmap.NodeReference) string {
	return roadmapReferenceKey(from) + ">" + roadmapReferenceKey(to)
}
