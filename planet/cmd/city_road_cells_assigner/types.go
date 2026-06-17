package main

import (
	"bufio"
	"encoding/json"
	"math"
	"os"
)

const (
	binaryMagic             = "OWRC"
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
	cityID         string
	osmID          string
	name           string
	displayName    string
	region         string
	adminLevel     string
	boundaryType   string
	geometryType   string
	bbox           bbox
	center         center
	outlinePath    string
	sourcePath     string
	shard          string
	roadCellsPath  string
	totalRoadCells *int
	roadCellBounds *cellBounds
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
