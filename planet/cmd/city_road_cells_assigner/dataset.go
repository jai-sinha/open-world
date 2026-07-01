package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

var supportedGeometryTypes = map[string]bool{
	"Polygon":      true,
	"MultiPolygon": true,
}

func readRegions(path string) map[string]struct{} {
	regions := make(map[string]struct{})
	if path == "" {
		return regions
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return regions
	}
	for _, rawLine := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		regions[line] = struct{}{}
	}
	return regions
}

func iterCityFiles(citiesDir string) ([]string, error) {
	var files []string
	err := filepath.Walk(citiesDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !info.IsDir() && strings.HasSuffix(path, ".geojson") {
			files = append(files, path)
		}
		return nil
	})
	sort.Strings(files)
	return files, err
}

func loadFeature(path string) (*feature, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var feat feature
	if err := json.Unmarshal(data, &feat); err != nil {
		return nil, err
	}
	return &feat, nil
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

func validateFeature(feat *feature) (bool, string) {
	if feat == nil {
		return false, "top-level JSON is not an object"
	}
	if feat.Type != "Feature" {
		return false, "GeoJSON object is not a Feature"
	}
	if feat.Geometry.Type == "" {
		return false, "feature.geometry is missing or invalid"
	}
	if !supportedGeometryTypes[feat.Geometry.Type] {
		return false, fmt.Sprintf("unsupported geometry type: %q", feat.Geometry.Type)
	}
	return true, ""
}

func iterPolygonRings(feat *feature) [][][]float64 {
	var rings [][][]float64
	switch feat.Geometry.Type {
	case "Polygon":
		var coords [][][]float64
		if err := json.Unmarshal(feat.Geometry.Coordinates, &coords); err == nil {
			rings = append(rings, coords...)
		}
	case "MultiPolygon":
		var coords [][][][]float64
		if err := json.Unmarshal(feat.Geometry.Coordinates, &coords); err == nil {
			for _, poly := range coords {
				rings = append(rings, poly...)
			}
		}
	}
	return rings
}

func iterOuterRings(feat *feature) [][][]float64 {
	var rings [][][]float64
	switch feat.Geometry.Type {
	case "Polygon":
		var coords [][][]float64
		if err := json.Unmarshal(feat.Geometry.Coordinates, &coords); err == nil {
			if len(coords) > 0 && len(coords[0]) > 0 {
				rings = append(rings, coords[0])
			}
		}
	case "MultiPolygon":
		var coords [][][][]float64
		if err := json.Unmarshal(feat.Geometry.Coordinates, &coords); err == nil {
			for _, poly := range coords {
				if len(poly) > 0 && len(poly[0]) > 0 {
					rings = append(rings, poly[0])
				}
			}
		}
	}
	return rings
}

func computeBboxFromFeature(feat *feature) (*bbox, error) {
	minLat := 90.0
	maxLat := -90.0
	minLng := 180.0
	maxLng := -180.0
	found := false

	for _, ring := range iterPolygonRings(feat) {
		for _, point := range ring {
			if len(point) < 2 {
				continue
			}
			lng := point[0]
			lat := point[1]
			found = true
			if lat < minLat {
				minLat = lat
			}
			if lat > maxLat {
				maxLat = lat
			}
			if lng < minLng {
				minLng = lng
			}
			if lng > maxLng {
				maxLng = lng
			}
		}
	}

	if !found {
		return nil, errors.New("could not compute bbox")
	}

	return &bbox{
		MinLat: minLat,
		MaxLat: maxLat,
		MinLng: minLng,
		MaxLng: maxLng,
	}, nil
}

func computeCenter(box bbox) center {
	return center{
		Lat: (box.MinLat + box.MaxLat) / 2.0,
		Lng: (box.MinLng + box.MaxLng) / 2.0,
	}
}

func normalizeCityID(path string, feat *feature) string {
	props := getProperties(feat)
	if props != nil {
		if osmID, ok := props["osm_id"].(string); ok && strings.TrimSpace(osmID) != "" {
			return strings.TrimSpace(osmID)
		}
	}

	if feat.ID != nil {
		switch id := feat.ID.(type) {
		case string:
			if strings.TrimSpace(id) != "" {
				return strings.ReplaceAll(strings.TrimSpace(id), "/", "_")
			}
		default:
			return fmt.Sprintf("%v", id)
		}
	}

	base := filepath.Base(path)
	if strings.HasSuffix(base, ".geojson") {
		return base[:len(base)-8]
	}
	return base
}

func normalizeName(feat *feature, cityID string) string {
	props := getProperties(feat)
	if props == nil {
		return cityID
	}
	for _, key := range []string{"name", "name:en", "official_name", "short_name"} {
		if v, ok := props[key].(string); ok && strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return cityID
}

func chooseShard(region, cityID string) string {
	if region != "" {
		return region
	}
	parts := strings.SplitN(cityID, "_", 2)
	if parts[0] != "" {
		return parts[0]
	}
	return "unknown"
}

func buildOutlinePath(cityID string) string {
	return "outlines/" + cityID + ".json"
}

func buildRoadCellsPath(cityID, shard string) string {
	return "city-road-cells/" + shard + "/" + cityID + ".bin"
}

func buildCityRecord(
	path string,
	feat *feature,
	citiesDir string,
	regions map[string]struct{},
	cellSize int,
) (*cityRecord, error) {
	computedBbox, err := computeBboxFromFeature(feat)
	if err != nil {
		return nil, err
	}

	cityID := normalizeCityID(path, feat)
	props := getProperties(feat)

	osmID := cityID
	if props != nil {
		if v, ok := props["osm_id"].(string); ok && strings.TrimSpace(v) != "" {
			osmID = strings.TrimSpace(v)
		}
	}

	name := normalizeName(feat, cityID)
	displayName := name

	region := ""
	if props != nil {
		if roadTiles, ok := props["road_tiles"].(string); ok && roadTiles != "" {
			base := filepath.Base(roadTiles)
			base = strings.TrimSuffix(base, ".pmtiles")
			if _, ok := regions[base]; ok {
				region = base
			}
		}
	}

	adminLevel := ""
	boundaryType := ""
	if props != nil {
		if v, ok := props["admin_level"]; ok {
			adminLevel = fmt.Sprintf("%v", v)
		}
		if v, ok := props["boundary"]; ok {
			boundaryType = fmt.Sprintf("%v", v)
		}
	}

	computedCenter := computeCenter(*computedBbox)
	roadCellBounds := bboxToCellBounds(*computedBbox, cellSize)
	shard := chooseShard(region, cityID)
	relSourcePath, _ := filepath.Rel(citiesDir, path)

	return &cityRecord{
		cityID:         cityID,
		osmID:          osmID,
		name:           name,
		displayName:    displayName,
		region:         region,
		adminLevel:     adminLevel,
		boundaryType:   boundaryType,
		geometryType:   feat.Geometry.Type,
		bbox:           *computedBbox,
		center:         computedCenter,
		outlinePath:    buildOutlinePath(cityID),
		sourcePath:     relSourcePath,
		shard:          shard,
		roadCellsPath:  buildRoadCellsPath(cityID, shard),
		roadCellBounds: &roadCellBounds,
	}, nil
}

func ringArea(ring [][]float64) float64 {
	if len(ring) < 3 {
		return 0.0
	}
	area := 0.0
	prev := ring[len(ring)-1]
	for _, cur := range ring {
		if len(prev) < 2 || len(cur) < 2 {
			prev = cur
			continue
		}
		x1, y1 := prev[0], prev[1]
		x2, y2 := cur[0], cur[1]
		area += (x1 * y2) - (x2 * y1)
		prev = cur
	}
	return area / 2.0
}

func choosePrimaryOuterRing(feat *feature) [][]float64 {
	bestRing := make([][]float64, 0)
	bestAbsArea := -1.0
	for _, ring := range iterOuterRings(feat) {
		area := math.Abs(ringArea(ring))
		if area > bestAbsArea {
			bestAbsArea = area
			bestRing = ring
		}
	}
	return bestRing
}

func normalizeRingPoints(ring [][]float64) [][]float64 {
	var points [][]float64
	for _, pt := range ring {
		if len(pt) < 2 {
			continue
		}
		points = append(points, []float64{pt[0], pt[1]})
	}
	if len(points) >= 2 &&
		points[0][0] == points[len(points)-1][0] &&
		points[0][1] == points[len(points)-1][1] {
		points = points[:len(points)-1]
	}
	return points
}

func dpSimplify(points [][]float64, tolerance float64) [][]float64 {
	if len(points) <= 2 || tolerance <= 0 {
		result := make([][]float64, len(points))
		copy(result, points)
		return result
	}

	tol2 := tolerance * tolerance
	keep := make([]bool, len(points))
	keep[0] = true
	keep[len(points)-1] = true

	type pair struct{ start, end int }
	stack := []pair{{0, len(points) - 1}}

	for len(stack) > 0 {
		n := len(stack) - 1
		start, end := stack[n].start, stack[n].end
		stack = stack[:n]

		if end-start < 2 {
			continue
		}

		x1, y1 := points[start][0], points[start][1]
		x2, y2 := points[end][0], points[end][1]
		dx := x2 - x1
		dy := y2 - y1
		segLen2 := dx*dx + dy*dy

		maxD2 := -1.0
		maxIdx := start

		for i := start + 1; i < end; i++ {
			px := points[i][0] - x1
			py := points[i][1] - y1
			var d2 float64
			if segLen2 == 0 {
				d2 = px*px + py*py
			} else {
				t := (px*dx + py*dy) / segLen2
				qx := px - t*dx
				qy := py - t*dy
				d2 = qx*qx + qy*qy
			}
			if d2 > maxD2 {
				maxD2 = d2
				maxIdx = i
			}
		}

		if maxD2 > tol2 {
			keep[maxIdx] = true
			stack = append(stack, pair{start, maxIdx})
			stack = append(stack, pair{maxIdx, end})
		}
	}

	result := make([][]float64, 0, len(points))
	for i, pt := range points {
		if keep[i] {
			result = append(result, pt)
		}
	}
	return result
}

func buildOutlinePayload(cityID string, feat *feature, tolerance float64) map[string]interface{} {
	var outlines [][][]float64

	for _, ring := range iterOuterRings(feat) {
		points := normalizeRingPoints(ring)
		if len(points) < 2 {
			continue
		}
		simplified := dpSimplify(points, tolerance)
		if len(simplified) >= 2 {
			outlines = append(outlines, simplified)
		}
	}

	if len(outlines) == 0 {
		primary := normalizeRingPoints(choosePrimaryOuterRing(feat))
		if len(primary) >= 2 {
			outlines = append(outlines, primary)
		}
	}

	return map[string]interface{}{
		"version":      1,
		"cityId":       cityID,
		"toleranceDeg": tolerance,
		"outlines":     outlines,
	}
}

func writeOutline(outputDir, cityID string, feat *feature, tolerance float64, pretty bool) error {
	outlinesRoot := filepath.Join(outputDir, "outlines")
	if err := os.MkdirAll(outlinesRoot, 0o755); err != nil {
		return err
	}
	payload := buildOutlinePayload(cityID, feat, tolerance)
	return writeJSON(filepath.Join(outlinesRoot, cityID+".json"), payload, pretty)
}

func clampLat(lat float64) float64 {
	if lat < -90.0 {
		return -90.0
	}
	if lat > 90.0 {
		return 90.0
	}
	return lat
}

func clampLng(lng float64) float64 {
	if lng < -180.0 {
		return -180.0
	}
	if lng > 180.0 {
		return 180.0
	}
	return lng
}

func bucketFloor(value, size float64) float64 {
	return math.Floor(value/size) * size
}

func formatBucketValue(value float64) string {
	if math.Abs(value) < 1e-12 {
		value = 0.0
	}
	text := fmt.Sprintf("%.6f", value)
	text = strings.TrimRight(text, "0")
	text = strings.TrimRight(text, ".")
	if text == "" {
		return "0"
	}
	return text
}

func computeDiscoveryBuckets(box bbox, bucketSize float64) []string {
	minLat := clampLat(box.MinLat)
	maxLat := clampLat(box.MaxLat)
	minLng := clampLng(box.MinLng)
	maxLng := clampLng(box.MaxLng)

	startLat := bucketFloor(minLat, bucketSize)
	endLat := bucketFloor(maxLat, bucketSize)
	startLng := bucketFloor(minLng, bucketSize)
	endLng := bucketFloor(maxLng, bucketSize)

	var buckets []string
	for lat := startLat; lat <= endLat+1e-12; lat += bucketSize {
		for lng := startLng; lng <= endLng+1e-12; lng += bucketSize {
			buckets = append(buckets, fmt.Sprintf("%s,%s", formatBucketValue(lat), formatBucketValue(lng)))
		}
	}
	return buckets
}

func cityRecordToManifestEntry(city *cityRecord) map[string]interface{} {
	entry := map[string]interface{}{
		"id":               city.cityID,
		"osmId":            city.osmID,
		"name":             city.name,
		"displayName":      city.displayName,
		"region":           city.region,
		"adminLevel":       city.adminLevel,
		"boundaryType":     city.boundaryType,
		"geometryType":     city.geometryType,
		"bbox":             city.bbox,
		"center":           city.center,
		"outlinePath":      city.outlinePath,
		"sourcePath":       city.sourcePath,
		"shard":            city.shard,
		"roadCellsPath":    city.roadCellsPath,
		"roadCellEncoding": "xy-int32-pairs-v1",
	}
	if city.totalRoadCells != nil {
		entry["totalRoadCells"] = *city.totalRoadCells
	} else {
		entry["totalRoadCells"] = nil
	}
	if city.roadCellBounds != nil {
		entry["roadCellBounds"] = city.roadCellBounds
	} else {
		entry["roadCellBounds"] = nil
	}
	return entry
}

func buildManifest(
	cities []*cityRecord,
	bucketSize, tolerance float64,
	cellSize int,
	citiesDir string,
	regions map[string]struct{},
) map[string]interface{} {
	byID := make(map[string]interface{}, len(cities))
	for _, city := range cities {
		byID[city.cityID] = cityRecordToManifestEntry(city)
	}

	regionsSummary := make(map[string]map[string]int)
	for _, city := range cities {
		regionName := city.region
		if regionName == "" {
			regionName = "unknown"
		}
		entry := regionsSummary[regionName]
		if entry == nil {
			entry = map[string]int{"cityCount": 0}
			regionsSummary[regionName] = entry
		}
		entry["cityCount"]++
	}

	normalizedRegionsSummary := make(map[string]interface{})
	var regionNames []string
	for name := range regionsSummary {
		regionNames = append(regionNames, name)
	}
	sort.Strings(regionNames)
	for _, name := range regionNames {
		normalizedRegionsSummary[name] = map[string]int{"cityCount": regionsSummary[name]["cityCount"]}
	}

	configuredRegions := make([]string, 0, len(regions))
	for name := range regions {
		configuredRegions = append(configuredRegions, name)
	}
	sort.Strings(configuredRegions)

	shards := make(map[string]bool)
	cityRegions := make(map[string]bool)
	withRoadCells := 0
	for _, city := range cities {
		shards[city.shard] = true
		if city.region != "" {
			cityRegions[city.region] = true
		}
		if city.totalRoadCells != nil {
			withRoadCells++
		}
	}

	absCitiesDir, _ := filepath.Abs(citiesDir)

	return map[string]interface{}{
		"version":   2,
		"generator": "build_city_dataset.py",
		"schema": map[string]interface{}{
			"cityRoadCells":  "xy-int32-pairs-v1",
			"discoveryIndex": "bbox-bucket-candidates",
			"outlines":       "simplified-outer-rings",
		},
		"config": map[string]interface{}{
			"bucketSizeDeg":       bucketSize,
			"outlineToleranceDeg": tolerance,
			"cellSizeMeters":      cellSize,
			"citiesDir":           absCitiesDir,
		},
		"summary": map[string]interface{}{
			"cityCount":     len(cities),
			"shardCount":    len(shards),
			"regionCount":   len(cityRegions),
			"withRoadCells": withRoadCells,
		},
		"regions": map[string]interface{}{
			"configured":   configuredRegions,
			"usedByCities": normalizedRegionsSummary,
		},
		"cities": byID,
	}
}

func buildDiscoveryIndex(cities []*cityRecord, bucketSize float64) map[string]interface{} {
	buckets := make(map[string][]string)
	for _, city := range cities {
		for _, bucket := range computeDiscoveryBuckets(city.bbox, bucketSize) {
			buckets[bucket] = append(buckets[bucket], city.cityID)
		}
	}

	for bucket := range buckets {
		sort.Strings(buckets[bucket])
	}

	return map[string]interface{}{
		"version":       1,
		"generator":     "build_city_dataset.py",
		"strategy":      "bbox-bucket-candidates",
		"bucketSizeDeg": bucketSize,
		"bucketCount":   len(buckets),
		"buckets":       buckets,
	}
}

func regionResponseToMap(r *regionResponse) map[string]interface{} {
	b, _ := json.Marshal(r)
	var m map[string]interface{}
	json.Unmarshal(b, &m)
	return m
}

func buildBuildMetadata(
	cities []*cityRecord,
	regionResponses []*regionResponse,
	started time.Time,
	citiesDir, regionsFile, sourcesDir, outputDir string,
	bucketSize, tolerance float64,
	cellSize int,
	skipRoadCells bool,
) map[string]interface{} {
	elapsed := time.Since(started).Seconds()

	citiesWithRoadCells := 0
	totalAssignedRoadCells := 0
	for _, city := range cities {
		if city.totalRoadCells != nil {
			citiesWithRoadCells++
			totalAssignedRoadCells += *city.totalRoadCells
		}
	}

	regions := make([]map[string]interface{}, len(regionResponses))
	for i, r := range regionResponses {
		regions[i] = regionResponseToMap(r)
	}

	absCitiesDir, _ := filepath.Abs(citiesDir)
	absRegionsFile := ""
	if regionsFile != "" {
		absRegionsFile, _ = filepath.Abs(regionsFile)
	}
	absSourcesDir, _ := filepath.Abs(sourcesDir)
	absOutputDir, _ := filepath.Abs(outputDir)

	return map[string]interface{}{
		"version":        2,
		"generator":      "build_city_dataset.py",
		"generatedAtUtc": nowUTCISO(),
		"inputs": map[string]interface{}{
			"citiesDir":           absCitiesDir,
			"regionsFile":         absRegionsFile,
			"sourcesDir":          absSourcesDir,
			"roadsCacheDir":       "",
			"cellSizeMeters":      cellSize,
			"bucketSizeDeg":       bucketSize,
			"outlineToleranceDeg": tolerance,
			"cityCount":           len(cities),
		},
		"outputs": map[string]interface{}{
			"outputDir":          absOutputDir,
			"manifestPath":       filepath.Join(absOutputDir, "cities-manifest.json"),
			"discoveryIndexPath": filepath.Join(absOutputDir, "discovery-index.json"),
			"buildMetadataPath":  filepath.Join(absOutputDir, "build-metadata.json"),
			"roadCellsDir":       filepath.Join(absOutputDir, "city-road-cells"),
			"outlinesDir":        filepath.Join(absOutputDir, "outlines"),
			"regionMetadataDir":  filepath.Join(absOutputDir, "region-build-metadata"),
		},
		"summary": map[string]interface{}{
			"citiesWithRoadCells":    citiesWithRoadCells,
			"totalAssignedRoadCells": totalAssignedRoadCells,
			"regionsProcessed":       len(regionResponses),
			"skipRoadCells":          skipRoadCells,
		},
		"regions": regions,
		"timing": map[string]interface{}{
			"elapsedSeconds": math.Round(elapsed*1000) / 1000,
			"elapsedHuman":   fmt.Sprintf("%dm %ds", int(elapsed/60), int(elapsed)%60),
		},
	}
}

func writeJSON(path string, value interface{}, pretty bool) error {
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}

	var data []byte
	var err error
	if pretty {
		data, err = json.MarshalIndent(value, "", "  ")
		if err == nil {
			data = append(data, '\n')
		}
	} else {
		data, err = json.Marshal(value)
	}
	if err != nil {
		return err
	}

	return os.WriteFile(path, data, 0o644)
}

func writeRegionMetadata(outputDir, regionName string, payload map[string]interface{}, pretty bool) error {
	path := filepath.Join(outputDir, "region-build-metadata", regionName+".json")
	return writeJSON(path, payload, pretty)
}

func regionPbfPath(sourcesDir, regionName string) string {
	// Prefer a pre-filtered highways-only PBF if available (~10x smaller).
	// Create it with:
	//   osmium tags-filter <region>-latest.osm.pbf w/highway=* -o <region>-highways.osm.pbf --overwrite
	highwayPath := filepath.Join(sourcesDir, regionName+"-highways.osm.pbf")
	if _, err := os.Stat(highwayPath); err == nil {
		return highwayPath
	}
	return filepath.Join(sourcesDir, regionName+"-latest.osm.pbf")
}

func nowUTCISO() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05Z")
}

func eprint(args ...interface{}) {
	fmt.Fprintln(os.Stderr, args...)
}
