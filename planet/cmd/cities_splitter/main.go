package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

type geometry struct {
	Type        string          `json:"type"`
	Coordinates json.RawMessage `json:"coordinates"`
}

type feature struct {
	Type       string          `json:"type"`
	ID         interface{}     `json:"id,omitempty"`
	Geometry   geometry        `json:"geometry"`
	Properties json.RawMessage `json:"properties,omitempty"`
}

var typeIDRE = regexp.MustCompile(`^([nwra])(\d+)$`)
var typePrefix = map[string]string{"n": "node", "w": "way", "r": "relation", "a": "area"}

func deriveCityID(props map[string]interface{}, featID interface{}, lineNum int) string {
	if props != nil {
		if osmID, ok := props["osm_id"].(string); ok && strings.TrimSpace(osmID) != "" {
			return strings.TrimSpace(osmID)
		}
	}
	if featID != nil {
		switch id := featID.(type) {
		case string:
			fid := strings.TrimSpace(id)
			if strings.Contains(fid, "/") {
				return strings.ReplaceAll(fid, "/", "_")
			}
			if m := typeIDRE.FindStringSubmatch(fid); m != nil {
				prefix := typePrefix[m[1]]
				if prefix == "" {
					prefix = m[1]
				}
				return fmt.Sprintf("%s_%s", prefix, m[2])
			}
			if fid != "" {
				return fid
			}
		default:
			return fmt.Sprintf("%v", id)
		}
	}
	return fmt.Sprintf("feature_%d", lineNum)
}

func getProperties(feat *feature) map[string]interface{} {
	if len(feat.Properties) == 0 {
		return nil
	}
	var props map[string]interface{}
	if err := json.Unmarshal(feat.Properties, &props); err != nil {
		return nil
	}
	return props
}

func main() {
	skipExisting := flag.Bool("skip-existing", false, "Skip files that already exist")
	flag.Parse()

	if flag.NArg() < 2 {
		fmt.Fprintf(os.Stderr, "Usage: %s [--skip-existing] <input.geojsonseq> <output_dir>\n", os.Args[0])
		os.Exit(1)
	}

	inputPath := flag.Arg(0)
	outputDir := flag.Arg(1)

	if err := os.MkdirAll(outputDir, 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "error: failed to create output directory: %v\n", err)
		os.Exit(1)
	}

	inFile, err := os.Open(inputPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: failed to open input file: %v\n", err)
		os.Exit(1)
	}
	defer inFile.Close()

	count := 0
	skipped := 0
	errors := 0
	missingID := 0
	lineNum := 0

	scanner := bufio.NewScanner(inFile)
	scanner.Buffer(make([]byte, 0, 1024*1024), 10*1024*1024)

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		// Strip RS (Record Separator) prefix
		if line[0] == 0x1E {
			line = line[1:]
		}

		lineNum++

		var feat feature
		if err := json.Unmarshal([]byte(line), &feat); err != nil {
			fmt.Fprintf(os.Stderr, "warn: JSON decode error at line %d: %v\n", lineNum, err)
			errors++
			continue
		}

		props := getProperties(&feat)
		cityID := deriveCityID(props, feat.ID, lineNum)
		if strings.HasPrefix(cityID, "feature_") {
			missingID++
		}

		outPath := filepath.Join(outputDir, cityID+".geojson")

		if *skipExisting {
			if _, err := os.Stat(outPath); err == nil {
				skipped++
				continue
			}
		}

		out, err := os.Create(outPath)
		if err != nil {
			fmt.Fprintf(os.Stderr, "error: failed to create %s: %v\n", outPath, err)
			errors++
			continue
		}

		enc := json.NewEncoder(out)
		if err := enc.Encode(feat); err != nil {
			fmt.Fprintf(os.Stderr, "error: failed to write %s: %v\n", outPath, err)
			out.Close()
			errors++
			continue
		}
		out.Close()
		count++
	}

	if err := scanner.Err(); err != nil {
		fmt.Fprintf(os.Stderr, "error: reading input file: %v\n", err)
		os.Exit(1)
	}

	fmt.Fprintf(os.Stderr, "Split %d cities, skipped existing %d, errors %d\n", count, skipped, errors)
	if missingID > 0 {
		fmt.Fprintf(os.Stderr, "  ⚠️  %d features had no id — used fallback names\n", missingID)
	}

	if count == 0 {
		os.Exit(1)
	}
}
