package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type cliArgs struct {
	citiesDir           string
	regionsFile         string
	outputDir           string
	sourcesDir          string
	bucketSizeDeg       float64
	outlineToleranceDeg float64
	cellSizeMeters      int
	manifestName        string
	discoveryIndexName  string
	buildMetadataName   string
	regionSplits        string
	skipRoadCells       bool
	resume              bool
	pretty              bool
}

func parseArgs() cliArgs {
	var args cliArgs
	flag.StringVar(&args.citiesDir, "cities-dir", "", "Directory containing per-city GeoJSON files.")
	flag.StringVar(&args.regionsFile, "regions-file", "", "Optional regions.txt file.")
	flag.StringVar(&args.outputDir, "output-dir", "", "Directory where dataset artifacts will be written.")
	flag.StringVar(&args.sourcesDir, "sources-dir", "/sources", "Directory containing <region>-latest.osm.pbf files.")
	flag.Float64Var(&args.bucketSizeDeg, "bucket-size-deg", 0.25, "Discovery index bucket size in degrees.")
	flag.Float64Var(&args.outlineToleranceDeg, "outline-tolerance-deg", 0.0015, "Douglas-Peucker tolerance in degrees.")
	flag.IntVar(&args.cellSizeMeters, "cell-size-meters", defaultCellSizeMeters, "Canonical road cell size in meters.")
	flag.StringVar(&args.manifestName, "manifest-name", "cities-manifest.json", "Output manifest filename.")
	flag.StringVar(&args.discoveryIndexName, "discovery-index-name", "discovery-index.json", "Output discovery index filename.")
	flag.StringVar(&args.buildMetadataName, "build-metadata-name", "build-metadata.json", "Output build metadata filename.")
	flag.StringVar(&args.regionSplits, "region-splits", "", "Parent region split definitions (e.g. 'asia:asia-west,25,0,55,60;asia-central,55,0,85,60;asia-east,85,0,145,60').")
	flag.BoolVar(&args.skipRoadCells, "skip-road-cells", false, "Skip offline road-cell assignment.")
	flag.BoolVar(&args.resume, "resume", false, "Skip regions with existing metadata. Resumes a partial build.")
	flag.BoolVar(&args.pretty, "pretty", false, "Pretty-print JSON outputs.")
	flag.Parse()

	if args.citiesDir == "" {
		fatalf("error: --cities-dir is required")
	}
	if args.outputDir == "" {
		fatalf("error: --output-dir is required")
	}
	if args.bucketSizeDeg <= 0 {
		fatalf("error: --bucket-size-deg must be > 0")
	}
	if args.outlineToleranceDeg < 0 {
		fatalf("error: --outline-tolerance-deg must be >= 0")
	}
	if args.cellSizeMeters <= 0 {
		fatalf("error: --cell-size-meters must be > 0")
	}

	return args
}

func main() {
	args := parseArgs()
	startedAt := time.Now()

	os.MkdirAll(args.outputDir, 0o755)

	// 1. Read regions
	regionsByName := readRegions(args.regionsFile)
	regionSplits := parseRegionSplits(args.regionSplits)

	// 2. Load cities
	if _, err := os.Stat(args.citiesDir); os.IsNotExist(err) {
		fatalf("error: cities directory does not exist: %s", args.citiesDir)
	}

	cityFiles, err := iterCityFiles(args.citiesDir)
	if err != nil {
		fatalf("error: failed to list city files: %v", err)
	}

	var cities []*cityRecord
	errors := 0
	skipped := 0
	duplicates := 0
	outlinesWritten := 0

	if args.resume {
		if cached, ok := loadCityCache(args.outputDir, args.cellSizeMeters, args.citiesDir, args.regionSplits); ok {
			cities = cached
		}
	}

	if len(cities) == 0 {
		cityIDsSeen := make(map[string]bool)
		for _, path := range cityFiles {
			feat, err := loadFeature(path)
			if err != nil {
				eprint("warn: failed to read", path, ":", err)
				errors++
				continue
			}

			ok, reason := validateFeature(feat)
			if !ok {
				eprint("warn: skipping", path, ":", reason)
				skipped++
				continue
			}

			city, err := buildCityRecord(path, feat, args.citiesDir, regionsByName, regionSplits, args.cellSizeMeters)
			if err != nil {
				eprint("warn: skipping", path, ":", err)
				skipped++
				continue
			}

			if cityIDsSeen[city.CityID] {
				eprint("warn: duplicate city id", city.CityID, "from", path, "; keeping first occurrence")
				duplicates++
				skipped++
				continue
			}

			if err := writeOutline(args.outputDir, city.CityID, feat, args.outlineToleranceDeg, args.pretty); err != nil {
				fatalf("error: %v", err)
			}

			cities = append(cities, city)
			cityIDsSeen[city.CityID] = true
			outlinesWritten++
		}

		sort.Slice(cities, func(i, j int) bool {
			return cities[i].CityID < cities[j].CityID
		})

		saveCityCache(args.outputDir, cities, args.cellSizeMeters, args.citiesDir, args.regionSplits, skipped, duplicates, errors)
	}

	// 3. Process regions
	var regionResponses []*regionResponse

	if !args.skipRoadCells {
		if len(regionsByName) == 0 {
			fatalf("error: no regions configured; road-cell assignment requires a populated regions file")
		}

		citiesWithoutRegion := []string{}
		for _, city := range cities {
			if city.Region == "" {
				citiesWithoutRegion = append(citiesWithoutRegion, city.CityID)
			}
		}
		if len(citiesWithoutRegion) > 0 {
			sample := strings.Join(citiesWithoutRegion[:min(len(citiesWithoutRegion), 10)], ", ")
			fatalf("error: some city boundaries could not be matched to a region from regions.txt; cannot build road cells for %d cities. sample: %s", len(citiesWithoutRegion), sample)
		}

		if _, err := os.Stat(args.sourcesDir); os.IsNotExist(err) {
			fatalf("error: source directory does not exist: %s", args.sourcesDir)
		}

		citiesByRegion := make(map[string][]*cityRecord)
		for _, city := range cities {
			if city.Region != "" {
				citiesByRegion[city.Region] = append(citiesByRegion[city.Region], city)
			}
		}

		var regionNames []string
		for name := range citiesByRegion {
			regionNames = append(regionNames, name)
		}
		sort.Strings(regionNames)

		// Build job list, handling resume skips inline
		type pendingJob struct {
			Name   string
			Cities []*cityRecord
		}
		var pending []pendingJob

		for _, regionName := range regionNames {
			regionCities := citiesByRegion[regionName]

			regionMetaPath := filepath.Join(args.outputDir, "region-build-metadata", regionName+".json")
			if args.resume {
				if data, err := os.ReadFile(regionMetaPath); err == nil {
					var existingMeta regionResponse
					if err := json.Unmarshal(data, &existingMeta); err == nil {
						for _, city := range regionCities {
							if stats, ok := existingMeta.Cities[city.CityID]; ok {
								count := stats.AssignedRoadCells
								city.TotalRoadCells = &count
							}
						}
						regionResponses = append(regionResponses, &existingMeta)
						eprint("skipping region", regionName, "("+fmt.Sprintf("%d", len(regionCities))+" cities, already complete)")
						continue
					}
				}
				eprint("resuming region", regionName, "(no existing metadata found)")
			}

			sourcePbf := regionPbfPath(args.sourcesDir, regionName)
			if _, err := os.Stat(sourcePbf); err != nil {
				fatalf("error: source PBF not found for region %s: %s", regionName, sourcePbf)
			}

			pending = append(pending, pendingJob{Name: regionName, Cities: regionCities})
		}

		// Process regions sequentially
		var firstErr error
		for _, pj := range pending {
			eprint("processing region", pj.Name, "("+fmt.Sprintf("%d", len(pj.Cities))+" cities)")

			sourcePbf := regionPbfPath(args.sourcesDir, pj.Name)
			regionStarted := time.Now()
			meta, err := processRegion(
				pj.Name, sourcePbf, args.outputDir, args.citiesDir,
				pj.Cities, args.cellSizeMeters, defaultStripeWidthCells, regionStarted,
			)
			if err != nil {
				firstErr = fmt.Errorf("error processing region %s: %w", pj.Name, err)
				break
			}

			regionMetaMap := regionResponseToMap(&meta)
			regionMetaMap["sourcePbf"] = sourcePbf
			writeRegionMetadata(args.outputDir, pj.Name, regionMetaMap, args.pretty)
			regionResponses = append(regionResponses, &meta)
		}

		if firstErr != nil {
			fatalf("%v", firstErr)
		}

		if len(regionResponses) == 0 {
			fatalf("error: road-cell generation processed zero regions")
		}

		missingRoadCellOutputs := []string{}
		for _, city := range cities {
			outPath := filepath.Join(args.outputDir, city.RoadCellsPath)
			if city.TotalRoadCells == nil || !fileExists(outPath) {
				missingRoadCellOutputs = append(missingRoadCellOutputs, city.CityID)
			}
		}
		if len(missingRoadCellOutputs) > 0 {
			sample := strings.Join(missingRoadCellOutputs[:min(len(missingRoadCellOutputs), 10)], ", ")
			fatalf("error: road-cell generation did not produce blobs for %d cities. sample: %s", len(missingRoadCellOutputs), sample)
		}
	}

	// 4. Build and write outputs
	manifest := buildManifest(cities, args.bucketSizeDeg, args.outlineToleranceDeg, args.cellSizeMeters, args.citiesDir, regionsByName)
	discoveryIndex := buildDiscoveryIndex(cities, args.bucketSizeDeg)
	buildMetadata := buildBuildMetadata(
		cities, regionResponses, startedAt,
		args.citiesDir, args.regionsFile, args.sourcesDir, args.outputDir,
		args.bucketSizeDeg, args.outlineToleranceDeg, args.cellSizeMeters,
		args.skipRoadCells,
	)

	manifestPath := filepath.Join(args.outputDir, args.manifestName)
	discoveryIndexPath := filepath.Join(args.outputDir, args.discoveryIndexName)
	buildMetadataPath := filepath.Join(args.outputDir, args.buildMetadataName)

	if err := writeJSON(manifestPath, manifest, args.pretty); err != nil {
		fatalf("error: %v", err)
	}
	if err := writeJSON(discoveryIndexPath, discoveryIndex, args.pretty); err != nil {
		fatalf("error: %v", err)
	}
	if err := writeJSON(buildMetadataPath, buildMetadata, args.pretty); err != nil {
		fatalf("error: %v", err)
	}

	// 5. Summary
	fmt.Printf(
		"Built city dataset: %d cities, %d discovery buckets, %d outlines\n",
		len(cities), discoveryIndex["bucketCount"].(int), outlinesWritten,
	)
	fmt.Printf("  manifest:        %s\n", manifestPath)
	fmt.Printf("  discovery index: %s\n", discoveryIndexPath)
	fmt.Printf("  build metadata:  %s\n", buildMetadataPath)
	fmt.Printf("  outlines dir:    %s\n", filepath.Join(args.outputDir, "outlines"))
	fmt.Printf("  road cells dir:  %s\n", filepath.Join(args.outputDir, "city-road-cells"))
	if skipped > 0 {
		fmt.Printf("  skipped:         %d\n", skipped)
	}
	if duplicates > 0 {
		fmt.Printf("  duplicate ids:   %d\n", duplicates)
	}
	if errors > 0 {
		fmt.Printf("  read errors:     %d\n", errors)
	}
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
