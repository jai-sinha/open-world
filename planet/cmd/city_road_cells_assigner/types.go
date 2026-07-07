package main

import (
	"bufio"
	"encoding/json"
	"math"
	"os"
	"strconv"
	"strings"
)

const (
	binaryMagic             = "OWRC"
	binaryVersion           = 1
	segmentChunkBytes       = 32
	featureLogEvery         = 50000
	stripeLogEvery          = 250000
	readChunkSegments       = 2048
	maxOpenStripeWriters    = 256
	stripeWriterBufferBytes = 64 << 10
	epsilon                 = 1e-9
	earthRadius             = 6378137.0
	originShift             = math.Pi * earthRadius
	defaultCellSizeMeters   = 50
	defaultStripeWidthCells = 1024
)

var defaultHighwayValues = []string{
	"bridleway", "cycleway", "footway", "living_street", "motorway",
	"motorway_link", "path", "pedestrian", "primary", "primary_link",
	"residential", "secondary", "secondary_link", "service", "steps",
	"tertiary", "tertiary_link", "track", "trunk", "trunk_link",
	"unclassified",
}

type bbox struct {
	MinLat float64 `json:"minLat"`
	MaxLat float64 `json:"maxLat"`
	MinLng float64 `json:"minLng"`
	MaxLng float64 `json:"maxLng"`
}

type center struct {
	Lat float64 `json:"lat"`
	Lng float64 `json:"lng"`
}

type cellBounds struct {
	MinX int32 `json:"minX"`
	MaxX int32 `json:"maxX"`
	MinY int32 `json:"minY"`
	MaxY int32 `json:"maxY"`
}

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

type meterPoint struct {
	X float64
	Y float64
}

type polygon struct {
	Rings [][]meterPoint
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

type cityRecord struct {
	CityID         string      `json:"cityId"`
	OsmID          string      `json:"osmId"`
	Name           string      `json:"name"`
	DisplayName    string      `json:"displayName"`
	Region         string      `json:"region"`
	AdminLevel     string      `json:"adminLevel"`
	BoundaryType   string      `json:"boundaryType"`
	GeometryType   string      `json:"geometryType"`
	BBox           bbox        `json:"bbox"`
	Center         center      `json:"center"`
	OutlinePath    string      `json:"outlinePath"`
	SourcePath     string      `json:"sourcePath"`
	Shard          string      `json:"shard"`
	RoadCellsPath  string      `json:"roadCellsPath"`
	TotalRoadCells *int        `json:"totalRoadCells"`
	RoadCellBounds *cellBounds `json:"roadCellBounds"`
}

type cityStats struct {
	CandidateCellsInBBox int    `json:"candidateCellsInBbox"`
	AssignedRoadCells    int    `json:"assignedRoadCells"`
	RoadCellsPath        string `json:"roadCellsPath"`
}

type subRegionDef struct {
	Name   string
	MinLon float64
	MinLat float64
	MaxLon float64
	MaxLat float64
}

type regionSplit struct {
	Parent     string
	SubRegions []subRegionDef
}

func parseRegionSplits(s string) map[string]*regionSplit {
	splits := make(map[string]*regionSplit)
	if s == "" {
		return splits
	}
	for _, def := range strings.Split(s, "|") {
		parts := strings.SplitN(def, ":", 2)
		if len(parts) != 2 {
			continue
		}
		parent := parts[0]
		rest := parts[1]
		if parent == "" || rest == "" {
			continue
		}

		rs := &regionSplit{Parent: parent}
		for _, subPart := range strings.Split(rest, ";") {
			subPart = strings.TrimSpace(subPart)
			if subPart == "" {
				continue
			}
			fields := strings.Split(subPart, ",")
			if len(fields) != 5 {
				continue
			}
			minLon, _ := strconv.ParseFloat(strings.TrimSpace(fields[1]), 64)
			minLat, _ := strconv.ParseFloat(strings.TrimSpace(fields[2]), 64)
			maxLon, _ := strconv.ParseFloat(strings.TrimSpace(fields[3]), 64)
			maxLat, _ := strconv.ParseFloat(strings.TrimSpace(fields[4]), 64)
			rs.SubRegions = append(rs.SubRegions, subRegionDef{
				Name:   strings.TrimSpace(fields[0]),
				MinLon: minLon,
				MinLat: minLat,
				MaxLon: maxLon,
				MaxLat: maxLat,
			})
		}

		if len(rs.SubRegions) > 0 {
			splits[parent] = rs
		}
	}
	return splits
}

func resolveSubRegionForBbox(split *regionSplit, box bbox) string {
	centerLon := (box.MinLng + box.MaxLng) / 2
	centerLat := (box.MinLat + box.MaxLat) / 2

	for _, sub := range split.SubRegions {
		if sub.MinLon <= centerLon && centerLon < sub.MaxLon &&
			sub.MinLat <= centerLat && centerLat < sub.MaxLat {
			return sub.Name
		}
	}

	// Fallback: nearest sub-region center
	best := ""
	bestDist := math.MaxFloat64
	for _, sub := range split.SubRegions {
		sLon := (sub.MinLon + sub.MaxLon) / 2
		sLat := (sub.MinLat + sub.MaxLat) / 2
		dist := (centerLon-sLon)*(centerLon-sLon) + (centerLat-sLat)*(centerLat-sLat)
		if dist < bestDist {
			bestDist = dist
			best = sub.Name
		}
	}
	return best
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
