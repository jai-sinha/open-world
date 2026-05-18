package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"sync"
	"time"
)

const (
	binaryMagic             = "CWRC"
	binaryVersion           = 1
	segmentChunkBytes       = 32
	featureLogEvery         = 50000
	stripeLogEvery          = 250000
	readChunkSegments       = 2048
	maxOpenStripeWriters    = 64
	stripeWriterBufferBytes = 64 << 10
	epsilon                 = 1e-9
	earthRadius             = 6378137.0
	originShift             = math.Pi * earthRadius
)

type bbox struct {
	MinLat float64 `json:"minLat"`
	MaxLat float64 `json:"maxLat"`
	MinLng float64 `json:"minLng"`
	MaxLng float64 `json:"maxLng"`
}

type cityRequest struct {
	CityID        string `json:"cityId"`
	RoadCellsPath string `json:"roadCellsPath"`
	SourcePath    string `json:"sourcePath"`
	BBox          bbox   `json:"bbox"`
}

type regionRequest struct {
	RegionName       string        `json:"regionName"`
	SourcePbf        string        `json:"sourcePbf"`
	OutputDir        string        `json:"outputDir"`
	CellSizeMeters   int           `json:"cellSizeMeters"`
	StripeWidthCells int           `json:"stripeWidthCells"`
	HighwayValues    []string      `json:"highwayValues"`
	Cities           []cityRequest `json:"cities"`
}

type cityStats struct {
	CandidateCellsInBBox int    `json:"candidateCellsInBbox"`
	AssignedRoadCells    int    `json:"assignedRoadCells"`
	RoadCellsPath        string `json:"roadCellsPath"`
}

type regionResponse struct {
	Region                 string               `json:"region"`
	CityCount              int                  `json:"cityCount"`
	CandidateRoadCells     int                  `json:"candidateRoadCells"`
	AssignedRoadCells      int                  `json:"assignedRoadCells"`
	RawRasterizedRoadCells int                  `json:"rawRasterizedRoadCells"`
	RoadFeatureCount       int                  `json:"roadFeatureCount"`
	StripeCount            int                  `json:"stripeCount"`
	StripeWidthCells       int                  `json:"stripeWidthCells"`
	ZeroRoadCellCities     int                  `json:"zeroRoadCellCities"`
	ElapsedSeconds         float64              `json:"elapsedSeconds"`
	Cities                 map[string]cityStats `json:"cities"`
}

type geometry struct {
	Type        string          `json:"type"`
	Coordinates json.RawMessage `json:"coordinates"`
}

type feature struct {
	Type     string   `json:"type"`
	Geometry geometry `json:"geometry"`
}

type meterPoint struct {
	X float64
	Y float64
}

type polygon struct {
	Rings [][]meterPoint
}

type cellBounds struct {
	MinX int32
	MaxX int32
	MinY int32
	MaxY int32
}

type cityBoundary struct {
	CityID         string
	RoadCellsPath  string
	RoadCellBounds cellBounds
	Polygons       []polygon
}

type segment struct {
	X1 float64
	Y1 float64
	X2 float64
	Y2 float64
}

type stripePartition struct {
	StripePaths      map[int]string
	RoadFeatureCount int
}

type partitionBatch struct {
	StripeSegments map[int][]segment
	FeatureCount   int
	Err            error
}

type stripeResult struct {
	StripeID               int
	CandidateRoadCells     int
	AssignedRoadCells      int
	RawRasterizedRoadCells int
	CityCandidateCounts    map[int]int
	CityAssignedCounts     map[int]int
	ResultPath             string
	Err                    error
}

type stripeWriterState struct {
	file    *os.File
	writer  *bufio.Writer
	lastUse int64
}

type stripeWriterCache struct {
	dir        string
	maxOpen    int
	useCounter int64
	paths      map[int]string
	open       map[int]*stripeWriterState
}

func main() {
	requestPath := flag.String("request", "", "Path to region assignment request JSON")
	flag.Parse()

	if *requestPath == "" {
		fatalf("error: --request is required")
	}

	if err := run(*requestPath); err != nil {
		fatalf("error: %v", err)
	}
}

func run(requestPath string) error {
	started := time.Now()

	requestBytes, err := os.ReadFile(requestPath)
	if err != nil {
		return fmt.Errorf("read request: %w", err)
	}

	var request regionRequest
	if err := json.Unmarshal(requestBytes, &request); err != nil {
		return fmt.Errorf("parse request: %w", err)
	}

	if request.SourcePbf == "" {
		return errors.New("sourcePbf is required")
	}
	if request.CellSizeMeters <= 0 {
		return errors.New("cellSizeMeters must be > 0")
	}
	if request.StripeWidthCells <= 0 {
		return errors.New("stripeWidthCells must be > 0")
	}
	if len(request.HighwayValues) == 0 {
		return errors.New("highwayValues must not be empty")
	}
	if _, err := os.Stat(request.SourcePbf); err != nil {
		return fmt.Errorf("sourcePbf: %w", err)
	}

	boundaries, citiesByStripe, err := loadCityBoundaries(request)
	if err != nil {
		return err
	}

	response, err := assignRegionCells(request, boundaries, citiesByStripe, started)
	if err != nil {
		return err
	}

	encoded, err := json.Marshal(response)
	if err != nil {
		return fmt.Errorf("encode response: %w", err)
	}

	_, err = os.Stdout.Write(encoded)
	return err
}

func loadCityBoundaries(request regionRequest) ([]cityBoundary, map[int][]int, error) {
	boundaries := make([]cityBoundary, 0, len(request.Cities))
	citiesByStripe := make(map[int][]int)

	for _, city := range request.Cities {
		polygons, err := loadCityPolygons(city.SourcePath)
		if err != nil {
			return nil, nil, fmt.Errorf("load city boundary for %s: %w", city.CityID, err)
		}

		bounds := bboxToCellBounds(city.BBox, request.CellSizeMeters)
		boundary := cityBoundary{
			CityID:         city.CityID,
			RoadCellsPath:  city.RoadCellsPath,
			RoadCellBounds: bounds,
			Polygons:       polygons,
		}
		boundaries = append(boundaries, boundary)
		cityIndex := len(boundaries) - 1

		minStripe := stripeIDForCell(bounds.MinX, request.StripeWidthCells)
		maxStripe := stripeIDForCell(bounds.MaxX, request.StripeWidthCells)
		for stripeID := minStripe; stripeID <= maxStripe; stripeID++ {
			citiesByStripe[stripeID] = append(citiesByStripe[stripeID], cityIndex)
		}
	}

	return boundaries, citiesByStripe, nil
}

func loadCityPolygons(path string) ([]polygon, error) {
	fileBytes, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var feat feature
	if err := json.Unmarshal(fileBytes, &feat); err != nil {
		return nil, err
	}
	if feat.Type != "Feature" {
		return nil, fmt.Errorf("GeoJSON object is not a Feature")
	}

	switch feat.Geometry.Type {
	case "Polygon":
		var coords [][][]float64
		if err := json.Unmarshal(feat.Geometry.Coordinates, &coords); err != nil {
			return nil, err
		}
		poly, ok := convertPolygon(coords)
		if !ok {
			return nil, fmt.Errorf("polygon has no valid rings")
		}
		return []polygon{poly}, nil
	case "MultiPolygon":
		var coords [][][][]float64
		if err := json.Unmarshal(feat.Geometry.Coordinates, &coords); err != nil {
			return nil, err
		}
		polygons := make([]polygon, 0, len(coords))
		for _, rawPolygon := range coords {
			poly, ok := convertPolygon(rawPolygon)
			if ok {
				polygons = append(polygons, poly)
			}
		}
		if len(polygons) == 0 {
			return nil, fmt.Errorf("multipolygon has no valid rings")
		}
		return polygons, nil
	default:
		return nil, fmt.Errorf("unsupported geometry type: %s", feat.Geometry.Type)
	}
}

func convertPolygon(rawRings [][][]float64) (polygon, bool) {
	rings := make([][]meterPoint, 0, len(rawRings))
	for _, rawRing := range rawRings {
		ring := make([]meterPoint, 0, len(rawRing))
		for _, pt := range rawRing {
			if len(pt) < 2 {
				continue
			}
			x, y := latLngToMeters(pt[1], pt[0])
			ring = append(ring, meterPoint{X: x, Y: y})
		}
		if len(ring) >= 4 {
			rings = append(rings, ring)
		}
	}
	if len(rings) == 0 {
		return polygon{}, false
	}
	return polygon{Rings: rings}, true
}

func assignRegionCells(
	request regionRequest,
	boundaries []cityBoundary,
	citiesByStripe map[int][]int,
	started time.Time,
) (regionResponse, error) {
	response := regionResponse{
		Region:           request.RegionName,
		CityCount:        len(boundaries),
		StripeWidthCells: request.StripeWidthCells,
		Cities:           make(map[string]cityStats, len(boundaries)),
	}
	if len(boundaries) == 0 {
		response.ElapsedSeconds = roundSeconds(time.Since(started).Seconds())
		return response, nil
	}

	for _, boundary := range boundaries {
		response.Cities[boundary.CityID] = cityStats{RoadCellsPath: boundary.RoadCellsPath}
	}

	regionTmpDir, err := os.MkdirTemp(request.OutputDir, "region-"+request.RegionName+"-")
	if err != nil {
		return response, fmt.Errorf("create temp dir: %w", err)
	}
	defer os.RemoveAll(regionTmpDir)

	segmentsDir := filepath.Join(regionTmpDir, "segment-stripes")
	stripeResultsDir := filepath.Join(regionTmpDir, "stripe-results")
	partition, err := partitionRoadSegmentsToStripes(
		request.SourcePbf,
		request.HighwayValues,
		request.CellSizeMeters,
		segmentsDir,
		request.StripeWidthCells,
	)
	if err != nil {
		return response, err
	}

	stripeIDs := make([]int, 0, len(partition.StripePaths))
	for stripeID := range partition.StripePaths {
		if len(citiesByStripe[stripeID]) == 0 {
			continue
		}
		stripeIDs = append(stripeIDs, stripeID)
	}
	sort.Ints(stripeIDs)

	results, err := processStripes(
		stripeIDs,
		partition.StripePaths,
		citiesByStripe,
		boundaries,
		request.CellSizeMeters,
		request.StripeWidthCells,
		stripeResultsDir,
	)
	if err != nil {
		return response, err
	}

	assignedByCity := make([]int, len(boundaries))
	candidateByCity := make([]int, len(boundaries))
	for _, stripeID := range stripeIDs {
		result := results[stripeID]
		response.CandidateRoadCells += result.CandidateRoadCells
		response.AssignedRoadCells += result.AssignedRoadCells
		response.RawRasterizedRoadCells += result.RawRasterizedRoadCells

		for cityIndex, count := range result.CityCandidateCounts {
			candidateByCity[cityIndex] += count
			stats := response.Cities[boundaries[cityIndex].CityID]
			stats.CandidateCellsInBBox = candidateByCity[cityIndex]
			response.Cities[boundaries[cityIndex].CityID] = stats
		}
		for cityIndex, count := range result.CityAssignedCounts {
			assignedByCity[cityIndex] += count
			stats := response.Cities[boundaries[cityIndex].CityID]
			stats.AssignedRoadCells = assignedByCity[cityIndex]
			response.Cities[boundaries[cityIndex].CityID] = stats
		}
	}

	tempPathsByCity := make([]string, len(boundaries))
	for cityIndex, boundary := range boundaries {
		tempPath := filepath.Join(regionTmpDir, filepath.FromSlash(boundary.RoadCellsPath))
		if err := initializeCityRoadCellsBinary(tempPath, request.CellSizeMeters); err != nil {
			return response, err
		}
		tempPathsByCity[cityIndex] = tempPath
	}

	for _, stripeID := range stripeIDs {
		resultPath := results[stripeID].ResultPath
		if resultPath == "" {
			continue
		}
		if err := appendStripeResultToCityFiles(resultPath, tempPathsByCity); err != nil {
			return response, err
		}
		if err := os.Remove(resultPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return response, err
		}
	}

	for cityIndex, boundary := range boundaries {
		if assignedByCity[cityIndex] == 0 {
			response.ZeroRoadCellCities++
		}
		tempPath := tempPathsByCity[cityIndex]
		if err := finalizeCityRoadCellsBinary(tempPath, assignedByCity[cityIndex]); err != nil {
			return response, err
		}
		finalPath := filepath.Join(request.OutputDir, filepath.FromSlash(boundary.RoadCellsPath))
		if err := os.MkdirAll(filepath.Dir(finalPath), 0o755); err != nil {
			return response, err
		}
		if err := os.Rename(tempPath, finalPath); err != nil {
			return response, err
		}
	}

	response.RoadFeatureCount = partition.RoadFeatureCount
	response.StripeCount = len(stripeIDs)
	response.ElapsedSeconds = roundSeconds(time.Since(started).Seconds())
	return response, nil
}

func processStripes(
	stripeIDs []int,
	stripePaths map[int]string,
	citiesByStripe map[int][]int,
	boundaries []cityBoundary,
	cellSize int,
	stripeWidth int,
	resultsDir string,
) (map[int]stripeResult, error) {
	results := make(map[int]stripeResult, len(stripeIDs))
	if len(stripeIDs) == 0 {
		return results, nil
	}

	workerCount := runtime.NumCPU()
	if workerCount < 1 {
		workerCount = 1
	}
	if workerCount > len(stripeIDs) {
		workerCount = len(stripeIDs)
	}

	jobs := make(chan int)
	out := make(chan stripeResult, workerCount)
	var wg sync.WaitGroup

	for i := 0; i < workerCount; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for stripeID := range jobs {
				out <- processStripe(
					stripeID,
					stripePaths[stripeID],
					citiesByStripe[stripeID],
					boundaries,
					cellSize,
					stripeWidth,
					resultsDir,
				)
			}
		}()
	}

	go func() {
		for _, stripeID := range stripeIDs {
			jobs <- stripeID
		}
		close(jobs)
		wg.Wait()
		close(out)
	}()

	for result := range out {
		if result.Err != nil {
			return nil, result.Err
		}
		results[result.StripeID] = result
	}

	return results, nil
}

func processStripe(
	stripeID int,
	segmentPath string,
	candidateCityIndexes []int,
	boundaries []cityBoundary,
	cellSize int,
	stripeWidth int,
	resultsDir string,
) stripeResult {
	result := stripeResult{
		StripeID:            stripeID,
		CityCandidateCounts: make(map[int]int),
		CityAssignedCounts:  make(map[int]int),
	}
	if segmentPath == "" || len(candidateCityIndexes) == 0 {
		return result
	}

	segments, err := loadSegments(segmentPath)
	if err != nil {
		result.Err = err
		return result
	}
	_ = os.Remove(segmentPath)

	cellSet := make(map[uint64]struct{})
	for _, seg := range segments {
		cells := rasterizedSegmentCellsMeters(seg.X1, seg.Y1, seg.X2, seg.Y2, cellSize)
		for _, cell := range cells {
			if stripeIDForCell(cell[0], stripeWidth) != stripeID {
				continue
			}
			result.RawRasterizedRoadCells++
			cellSet[cellKey(cell[0], cell[1])] = struct{}{}
		}
	}

	cells := make([][2]int32, 0, len(cellSet))
	for key := range cellSet {
		cells = append(cells, decodeCellKey(key))
	}
	sort.Slice(cells, func(i, j int) bool {
		if cells[i][0] == cells[j][0] {
			return cells[i][1] < cells[j][1]
		}
		return cells[i][0] < cells[j][0]
	})
	result.CandidateRoadCells = len(cells)
	if len(cells) == 0 {
		return result
	}

	matchesByCity := make(map[int][][2]int32)
	processed := 0
	for _, cell := range cells {
		processed++
		centerX, centerY := cellCenter(cell[0], cell[1], cellSize)
		for _, cityIndex := range candidateCityIndexes {
			boundary := boundaries[cityIndex]
			if !cellWithinBounds(cell, boundary.RoadCellBounds) {
				continue
			}
			result.CityCandidateCounts[cityIndex]++
			if cityContainsPoint(boundary, centerX, centerY) {
				matchesByCity[cityIndex] = append(matchesByCity[cityIndex], cell)
				result.CityAssignedCounts[cityIndex]++
				result.AssignedRoadCells++
			}
		}
		if processed%stripeLogEvery == 0 {
			logf("  tested %d stripe road cells...", processed)
		}
	}

	if len(matchesByCity) == 0 {
		return result
	}

	resultPath := filepath.Join(resultsDir, fmt.Sprintf("stripe_%d.cells", stripeID))
	if err := writeStripeResultFile(resultPath, matchesByCity); err != nil {
		result.Err = err
		return result
	}
	result.ResultPath = resultPath
	return result
}

func partitionRoadSegmentsToStripes(
	sourcePbf string,
	highwayValues []string,
	cellSize int,
	stripesDir string,
	stripeWidth int,
) (stripePartition, error) {
	if err := os.MkdirAll(stripesDir, 0o755); err != nil {
		return stripePartition{}, err
	}

	stream, waitFn, err := openRoadWayStream(sourcePbf, highwayValues)
	if err != nil {
		return stripePartition{}, err
	}
	defer stream.Close()

	writerCache := newStripeWriterCache(stripesDir, maxOpenStripeWriters)
	defer writerCache.Close()

	workerCount := runtime.NumCPU()
	if workerCount < 1 {
		workerCount = 1
	}

	jobs := make(chan []byte, workerCount*2)
	results := make(chan partitionBatch, workerCount*2)
	scanErrCh := make(chan error, 1)

	var wg sync.WaitGroup
	for i := 0; i < workerCount; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for line := range jobs {
				results <- buildPartitionBatch(line, cellSize, stripeWidth)
			}
		}()
	}

	go func() {
		scanner := bufio.NewScanner(stream)
		buffer := make([]byte, 0, 1<<20)
		scanner.Buffer(buffer, 128<<20)
		for scanner.Scan() {
			line := bytes.TrimSpace(scanner.Bytes())
			if len(line) == 0 {
				continue
			}
			jobs <- append([]byte(nil), line...)
		}
		close(jobs)
		scanErrCh <- scanner.Err()
	}()

	go func() {
		wg.Wait()
		close(results)
	}()

	featureCount := 0
	var firstErr error
	for batch := range results {
		if batch.Err != nil {
			if firstErr == nil {
				firstErr = batch.Err
			}
			continue
		}
		for stripeID, segments := range batch.StripeSegments {
			for _, seg := range segments {
				if err := writerCache.WriteSegment(stripeID, seg); err != nil {
					if firstErr == nil {
						firstErr = err
					}
					break
				}
			}
		}
		featureCount += batch.FeatureCount
		if featureCount > 0 && featureCount%featureLogEvery == 0 {
			logf("  partitioned %d road ways...", featureCount)
		}
	}

	if scanErr := <-scanErrCh; scanErr != nil && firstErr == nil {
		firstErr = scanErr
	}
	if waitErr := waitFn(); waitErr != nil && firstErr == nil {
		firstErr = waitErr
	}
	if closeErr := writerCache.Close(); closeErr != nil && firstErr == nil {
		firstErr = closeErr
	}
	if firstErr != nil {
		return stripePartition{}, firstErr
	}

	return stripePartition{
		StripePaths:      writerCache.Paths(),
		RoadFeatureCount: featureCount,
	}, nil
}

func buildPartitionBatch(line []byte, cellSize int, stripeWidth int) partitionBatch {
	if len(line) == 0 || line[0] != 'w' {
		return partitionBatch{}
	}

	segments, err := parseOPLWaySegments(line)
	if err != nil {
		return partitionBatch{Err: err}
	}
	if len(segments) == 0 {
		return partitionBatch{FeatureCount: 1}
	}

	stripeSegments := make(map[int][]segment)
	for _, seg := range segments {
		minCellX := cellCoord(math.Min(seg.X1, seg.X2), cellSize)
		maxCellX := cellCoord(math.Max(seg.X1, seg.X2), cellSize)
		minStripe := stripeIDForCell(minCellX, stripeWidth)
		maxStripe := stripeIDForCell(maxCellX, stripeWidth)
		for stripeID := minStripe; stripeID <= maxStripe; stripeID++ {
			stripeSegments[stripeID] = append(stripeSegments[stripeID], seg)
		}
	}

	return partitionBatch{StripeSegments: stripeSegments, FeatureCount: 1}
}

func openRoadWayStream(sourcePbf string, highwayValues []string) (io.ReadCloser, func() error, error) {
	tagsArgs := []string{"tags-filter", "--no-progress", "-f", "pbf", "-o", "-", "-t", sourcePbf}
	for _, highway := range highwayValues {
		tagsArgs = append(tagsArgs, "w/highway="+highway)
	}
	tagsCmd := exec.Command("osmium", tagsArgs...)
	tagsCmd.Stderr = os.Stderr

	addArgs := []string{
		"add-locations-to-ways",
		"--no-progress",
		"-F",
		"pbf",
		"-i",
		"dense_mmap_array",
		"-f",
		"opl,locations_on_ways=true,add_metadata=false",
		"-o",
		"-",
		"-",
	}
	addCmd := exec.Command("osmium", addArgs...)
	addCmd.Stderr = os.Stderr

	tagsStdout, err := tagsCmd.StdoutPipe()
	if err != nil {
		return nil, nil, err
	}
	addCmd.Stdin = tagsStdout
	addStdout, err := addCmd.StdoutPipe()
	if err != nil {
		return nil, nil, err
	}

	if err := addCmd.Start(); err != nil {
		return nil, nil, err
	}
	if err := tagsCmd.Start(); err != nil {
		_ = addCmd.Process.Kill()
		_, _ = io.Copy(io.Discard, addStdout)
		_ = addCmd.Wait()
		return nil, nil, err
	}

	waitFn := func() error {
		addErr := addCmd.Wait()
		tagsErr := tagsCmd.Wait()
		if addErr != nil {
			return fmt.Errorf("osmium add-locations-to-ways failed: %w", addErr)
		}
		if tagsErr != nil {
			return fmt.Errorf("osmium tags-filter failed: %w", tagsErr)
		}
		return nil
	}

	return addStdout, waitFn, nil
}

func parseOPLWaySegments(line []byte) ([]segment, error) {
	fields := bytes.Fields(line)
	if len(fields) == 0 || len(fields[0]) == 0 || fields[0][0] != 'w' {
		return nil, nil
	}

	var nodeField []byte
	for _, field := range fields[1:] {
		if len(field) > 0 && field[0] == 'N' {
			nodeField = field[1:]
			break
		}
	}
	if len(nodeField) == 0 {
		return nil, nil
	}

	entries := bytes.Split(nodeField, []byte{','})
	points := make([]meterPoint, 0, len(entries))
	for _, entry := range entries {
		point, ok, err := parseOPLNodeLocation(entry)
		if err != nil {
			return nil, err
		}
		if ok {
			points = append(points, point)
		}
	}
	if len(points) < 2 {
		return nil, nil
	}

	segments := make([]segment, 0, len(points)-1)
	prev := points[0]
	for _, cur := range points[1:] {
		segments = append(segments, segment{X1: prev.X, Y1: prev.Y, X2: cur.X, Y2: cur.Y})
		prev = cur
	}
	return segments, nil
}

func parseOPLNodeLocation(entry []byte) (meterPoint, bool, error) {
	entry = bytes.TrimSpace(entry)
	if len(entry) == 0 {
		return meterPoint{}, false, nil
	}
	xPos := bytes.IndexByte(entry, 'x')
	if xPos < 0 {
		return meterPoint{}, false, nil
	}
	yPosRel := bytes.IndexByte(entry[xPos+1:], 'y')
	if yPosRel < 0 {
		return meterPoint{}, false, nil
	}
	yPos := xPos + 1 + yPosRel
	if yPos <= xPos+1 || yPos+1 >= len(entry) {
		return meterPoint{}, false, fmt.Errorf("invalid OPL node location: %q", entry)
	}

	lng, err := strconv.ParseFloat(string(entry[xPos+1:yPos]), 64)
	if err != nil {
		return meterPoint{}, false, fmt.Errorf("parse OPL longitude %q: %w", entry, err)
	}
	lat, err := strconv.ParseFloat(string(entry[yPos+1:]), 64)
	if err != nil {
		return meterPoint{}, false, fmt.Errorf("parse OPL latitude %q: %w", entry, err)
	}

	x, y := latLngToMeters(lat, lng)
	return meterPoint{X: x, Y: y}, true, nil
}

func newStripeWriterCache(dir string, maxOpen int) *stripeWriterCache {
	return &stripeWriterCache{
		dir:     dir,
		maxOpen: maxOpen,
		paths:   make(map[int]string),
		open:    make(map[int]*stripeWriterState),
	}
}

func (c *stripeWriterCache) Paths() map[int]string {
	out := make(map[int]string, len(c.paths))
	for stripeID, path := range c.paths {
		out[stripeID] = path
	}
	return out
}

func (c *stripeWriterCache) WriteSegment(stripeID int, seg segment) error {
	writer, err := c.getWriter(stripeID)
	if err != nil {
		return err
	}
	var buf [segmentChunkBytes]byte
	binary.LittleEndian.PutUint64(buf[0:8], math.Float64bits(seg.X1))
	binary.LittleEndian.PutUint64(buf[8:16], math.Float64bits(seg.Y1))
	binary.LittleEndian.PutUint64(buf[16:24], math.Float64bits(seg.X2))
	binary.LittleEndian.PutUint64(buf[24:32], math.Float64bits(seg.Y2))
	_, err = writer.writer.Write(buf[:])
	return err
}

func (c *stripeWriterCache) getWriter(stripeID int) (*stripeWriterState, error) {
	if state, ok := c.open[stripeID]; ok {
		c.useCounter++
		state.lastUse = c.useCounter
		return state, nil
	}
	if len(c.open) >= c.maxOpen {
		if err := c.evictOne(); err != nil {
			return nil, err
		}
	}

	path := filepath.Join(c.dir, fmt.Sprintf("stripe_%d.seg", stripeID))
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	c.useCounter++
	state := &stripeWriterState{
		file:    file,
		writer:  bufio.NewWriterSize(file, stripeWriterBufferBytes),
		lastUse: c.useCounter,
	}
	c.open[stripeID] = state
	c.paths[stripeID] = path
	return state, nil
}

func (c *stripeWriterCache) evictOne() error {
	var evictStripe int
	var evictState *stripeWriterState
	for stripeID, state := range c.open {
		if evictState == nil || state.lastUse < evictState.lastUse {
			evictStripe = stripeID
			evictState = state
		}
	}
	if evictState == nil {
		return nil
	}
	if err := evictState.writer.Flush(); err != nil {
		return err
	}
	if err := evictState.file.Close(); err != nil {
		return err
	}
	delete(c.open, evictStripe)
	return nil
}

func (c *stripeWriterCache) Close() error {
	var firstErr error
	for stripeID, state := range c.open {
		if err := state.writer.Flush(); err != nil && firstErr == nil {
			firstErr = err
		}
		if err := state.file.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
		delete(c.open, stripeID)
	}
	return firstErr
}

func loadSegments(path string) ([]segment, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	reader := bufio.NewReader(file)
	buf := make([]byte, segmentChunkBytes*readChunkSegments)
	segments := make([]segment, 0)

	for {
		n, err := io.ReadFull(reader, buf)
		if errors.Is(err, io.EOF) {
			break
		}
		if errors.Is(err, io.ErrUnexpectedEOF) {
			if n%segmentChunkBytes != 0 {
				return nil, fmt.Errorf("invalid segment file length: %s", path)
			}
			for offset := 0; offset < n; offset += segmentChunkBytes {
				segments = append(segments, decodeSegment(buf[offset:offset+segmentChunkBytes]))
			}
			break
		}
		if err != nil {
			return nil, err
		}
		for offset := 0; offset < n; offset += segmentChunkBytes {
			segments = append(segments, decodeSegment(buf[offset:offset+segmentChunkBytes]))
		}
	}

	return segments, nil
}

func decodeSegment(buf []byte) segment {
	return segment{
		X1: math.Float64frombits(binary.LittleEndian.Uint64(buf[0:8])),
		Y1: math.Float64frombits(binary.LittleEndian.Uint64(buf[8:16])),
		X2: math.Float64frombits(binary.LittleEndian.Uint64(buf[16:24])),
		Y2: math.Float64frombits(binary.LittleEndian.Uint64(buf[24:32])),
	}
}

func writeStripeResultFile(path string, matchesByCity map[int][][2]int32) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	file, err := os.Create(path)
	if err != nil {
		return err
	}
	defer file.Close()

	writer := bufio.NewWriterSize(file, 1<<20)
	cityIndexes := make([]int, 0, len(matchesByCity))
	for cityIndex := range matchesByCity {
		cityIndexes = append(cityIndexes, cityIndex)
	}
	sort.Ints(cityIndexes)

	var header [8]byte
	var cellBuf [8]byte
	for _, cityIndex := range cityIndexes {
		cells := matchesByCity[cityIndex]
		binary.LittleEndian.PutUint32(header[0:4], uint32(cityIndex))
		binary.LittleEndian.PutUint32(header[4:8], uint32(len(cells)))
		if _, err := writer.Write(header[:]); err != nil {
			return err
		}
		for _, cell := range cells {
			binary.LittleEndian.PutUint32(cellBuf[0:4], uint32(cell[0]))
			binary.LittleEndian.PutUint32(cellBuf[4:8], uint32(cell[1]))
			if _, err := writer.Write(cellBuf[:]); err != nil {
				return err
			}
		}
	}
	return writer.Flush()
}

func appendStripeResultToCityFiles(resultPath string, cityTempPaths []string) error {
	file, err := os.Open(resultPath)
	if err != nil {
		return err
	}
	defer file.Close()

	reader := bufio.NewReader(file)
	var header [8]byte
	for {
		_, err := io.ReadFull(reader, header[:])
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return err
		}
		cityIndex := int(binary.LittleEndian.Uint32(header[0:4]))
		count := int(binary.LittleEndian.Uint32(header[4:8]))
		if cityIndex < 0 || cityIndex >= len(cityTempPaths) {
			return fmt.Errorf("invalid city index %d in %s", cityIndex, resultPath)
		}
		dst, err := os.OpenFile(cityTempPaths[cityIndex], os.O_WRONLY|os.O_APPEND, 0o644)
		if err != nil {
			return err
		}
		_, copyErr := io.CopyN(dst, reader, int64(count)*8)
		closeErr := dst.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
	return nil
}

func latLngToMeters(lat, lng float64) (float64, float64) {
	x := (lng * originShift) / 180.0
	y := math.Log(math.Tan(((90.0+lat)*math.Pi)/360.0)) / (math.Pi / 180.0)
	y = (y * originShift) / 180.0
	return x, y
}

func rasterizedSegmentCellsMeters(x1, y1, x2, y2 float64, cellSize int) [][2]int32 {
	dx := x2 - x1
	dy := y2 - y1
	dist := math.Sqrt(dx*dx + dy*dy)
	steps := int(math.Max(1, math.Ceil(dist/(float64(cellSize)/2.0))))
	cells := make([][2]int32, 0, steps+1)
	var hasLast bool
	var last [2]int32
	for s := 0; s <= steps; s++ {
		t := 0.0
		if steps != 0 {
			t = float64(s) / float64(steps)
		}
		x := x1 + dx*t
		y := y1 + dy*t
		cell := [2]int32{cellCoord(x, cellSize), cellCoord(y, cellSize)}
		if !hasLast || cell != last {
			cells = append(cells, cell)
			last = cell
			hasLast = true
		}
	}
	return cells
}

func cellCoord(value float64, cellSize int) int32 {
	return int32(math.Floor(value / float64(cellSize)))
}

func stripeIDForCell(cellX int32, stripeWidth int) int {
	return floorDivInt(int(cellX), stripeWidth)
}

func floorDivInt(value int, divisor int) int {
	if value >= 0 {
		return value / divisor
	}
	return -(((-value) + divisor - 1) / divisor)
}

func cellCenter(cellX, cellY int32, cellSize int) (float64, float64) {
	return float64(cellX)*float64(cellSize) + float64(cellSize)/2.0,
		float64(cellY)*float64(cellSize) + float64(cellSize)/2.0
}

func bboxToCellBounds(box bbox, cellSize int) cellBounds {
	minXM, minYM := latLngToMeters(box.MinLat, box.MinLng)
	maxXM, maxYM := latLngToMeters(box.MaxLat, box.MaxLng)
	return cellBounds{
		MinX: cellCoord(math.Min(minXM, maxXM), cellSize),
		MaxX: cellCoord(math.Max(minXM, maxXM), cellSize),
		MinY: cellCoord(math.Min(minYM, maxYM), cellSize),
		MaxY: cellCoord(math.Max(minYM, maxYM), cellSize),
	}
}

func initializeCityRoadCellsBinary(path string, cellSize int) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	file, err := os.Create(path)
	if err != nil {
		return err
	}
	defer file.Close()

	if _, err := file.WriteString(binaryMagic); err != nil {
		return err
	}
	if err := binary.Write(file, binary.LittleEndian, uint8(binaryVersion)); err != nil {
		return err
	}
	if err := binary.Write(file, binary.LittleEndian, uint8(0)); err != nil {
		return err
	}
	if err := binary.Write(file, binary.LittleEndian, uint16(0)); err != nil {
		return err
	}
	if err := binary.Write(file, binary.LittleEndian, uint32(cellSize)); err != nil {
		return err
	}
	return binary.Write(file, binary.LittleEndian, uint32(0))
}

func finalizeCityRoadCellsBinary(path string, count int) error {
	file, err := os.OpenFile(path, os.O_RDWR, 0o644)
	if err != nil {
		return err
	}
	defer file.Close()

	if _, err := file.Seek(12, io.SeekStart); err != nil {
		return err
	}
	return binary.Write(file, binary.LittleEndian, uint32(count))
}

func cellWithinBounds(cell [2]int32, bounds cellBounds) bool {
	return cell[0] >= bounds.MinX && cell[0] <= bounds.MaxX && cell[1] >= bounds.MinY && cell[1] <= bounds.MaxY
}

func cityContainsPoint(city cityBoundary, x, y float64) bool {
	point := meterPoint{X: x, Y: y}
	for _, poly := range city.Polygons {
		if polygonContainsPoint(poly, point) {
			return true
		}
	}
	return false
}

func polygonContainsPoint(poly polygon, point meterPoint) bool {
	if len(poly.Rings) == 0 {
		return false
	}
	if !ringContainsPoint(poly.Rings[0], point) {
		return false
	}
	for _, hole := range poly.Rings[1:] {
		if ringContainsPoint(hole, point) {
			return false
		}
	}
	return true
}

func ringContainsPoint(ring []meterPoint, point meterPoint) bool {
	inside := false
	for i, j := 0, len(ring)-1; i < len(ring); j, i = i, i+1 {
		a := ring[j]
		b := ring[i]
		if pointOnSegment(point, a, b) {
			return true
		}
		intersects := ((a.Y > point.Y) != (b.Y > point.Y)) &&
			(point.X < (b.X-a.X)*(point.Y-a.Y)/(b.Y-a.Y)+a.X)
		if intersects {
			inside = !inside
		}
	}
	return inside
}

func pointOnSegment(p, a, b meterPoint) bool {
	cross := (p.Y-a.Y)*(b.X-a.X) - (p.X-a.X)*(b.Y-a.Y)
	if math.Abs(cross) > epsilon {
		return false
	}
	dot := (p.X-a.X)*(b.X-a.X) + (p.Y-a.Y)*(b.Y-a.Y)
	if dot < -epsilon {
		return false
	}
	lengthSq := (b.X-a.X)*(b.X-a.X) + (b.Y-a.Y)*(b.Y-a.Y)
	return dot <= lengthSq+epsilon
}

func cellKey(x, y int32) uint64 {
	return uint64(uint32(x))<<32 | uint64(uint32(y))
}

func decodeCellKey(key uint64) [2]int32 {
	return [2]int32{int32(uint32(key >> 32)), int32(uint32(key))}
}

func roundSeconds(value float64) float64 {
	return math.Round(value*1000) / 1000
}

func logf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
}

func fatalf(format string, args ...any) {
	logf(format, args...)
	os.Exit(1)
}
