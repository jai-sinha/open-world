package main

import (
	"bufio"
	"compress/zlib"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"

	"github.com/qedus/osmpbf/OSMPBF"
	"google.golang.org/protobuf/proto"
)

// readBlob reads the next PBF blob (header + data) from the pipe, decompresses it,
// and returns the raw PrimitiveBlock bytes.
// At EOF it returns io.EOF.
func readBlob(r *bufio.Reader) ([]byte, error) {
	var headerSize uint32
	if err := binary.Read(r, binary.BigEndian, &headerSize); err != nil {
		return nil, err
	}
	header := make([]byte, headerSize)
	if _, err := io.ReadFull(r, header); err != nil {
		return nil, fmt.Errorf("read blob header: %w", err)
	}
	var blobHeader OSMPBF.BlobHeader
	if err := proto.Unmarshal(header, &blobHeader); err != nil {
		return nil, fmt.Errorf("unmarshal blob header: %w", err)
	}
	if blobHeader.GetType() != "OSMData" {
		if _, err := io.CopyN(io.Discard, r, int64(blobHeader.GetDatasize())); err != nil {
			return nil, fmt.Errorf("skip blob: %w", err)
		}
		return nil, nil // not OSMData, caller should retry
	}
	raw := make([]byte, blobHeader.GetDatasize())
	if _, err := io.ReadFull(r, raw); err != nil {
		return nil, fmt.Errorf("read blob data: %w", err)
	}
	var blob OSMPBF.Blob
	if err := proto.Unmarshal(raw, &blob); err != nil {
		return nil, fmt.Errorf("unmarshal blob: %w", err)
	}
	return decompressBlob(&blob)
}

func decompressBlob(blob *OSMPBF.Blob) ([]byte, error) {
	switch {
	case blob.GetRaw() != nil:
		return blob.GetRaw(), nil
	case blob.GetZlibData() != nil:
		r, err := zlib.NewReader(newByteReader(blob.GetZlibData()))
		if err != nil {
			return nil, fmt.Errorf("zlib reader: %w", err)
		}
		defer r.Close()
		out := make([]byte, 0, blob.GetRawSize())
		out, err = io.ReadAll(r)
		if err != nil {
			return nil, fmt.Errorf("zlib decompress: %w", err)
		}
		return out, nil
	default:
		return nil, fmt.Errorf("unsupported blob compression")
	}
}

// byteReader wraps a []byte as an io.Reader.
type byteReader struct{ data []byte }

func newByteReader(data []byte) *byteReader { return &byteReader{data: data} }
func (r *byteReader) Read(p []byte) (int, error) {
	if len(r.data) == 0 {
		return 0, io.EOF
	}
	n := copy(p, r.data)
	r.data = r.data[n:]
	return n, nil
}

// extractLocations decodes all DenseNodes and Nodes from a PrimitiveBlock
// and writes them into locations starting at offset. Returns the number
// of nodes written.
func extractLocations(pb *OSMPBF.PrimitiveBlock, locations []nodeLoc, offset int) int {
	granularity := int64(pb.GetGranularity())
	latOff := pb.GetLatOffset()
	lonOff := pb.GetLonOffset()
	n := offset

	for _, pg := range pb.GetPrimitivegroup() {
		// DenseNodes (delta-encoded, modern PBF)
		if dn := pg.GetDense(); dn != nil {
			ids := dn.GetId()
			lats := dn.GetLat()
			lons := dn.GetLon()
			var id, lat, lon int64
			for i := range ids {
				id = ids[i] + id
				lat = lats[i] + lat
				lon = lons[i] + lon
				locations[n] = nodeLoc{
					Lat: float32(float64(latOff+granularity*lat) * 1e-9),
					Lon: float32(float64(lonOff+granularity*lon) * 1e-9),
				}
				n++
			}
			_ = id
		}

		// Regular Nodes (legacy PBF)
		for _, node := range pg.GetNodes() {
			locations[n] = nodeLoc{
				Lat: float32(float64(latOff+granularity*node.GetLat()) * 1e-9),
				Lon: float32(float64(lonOff+granularity*node.GetLon()) * 1e-9),
			}
			n++
		}
	}

	return n
}

// readRenumberedPBF reads a renumbered OSM PBF stream from the pipe.
// It writes all node locations into locations (exact-sized, pre-allocated)
// and sends every decoded way as a wayJob to the jobs channel.
//
// nodesRead returns the total number of nodes written.
func readRenumberedPBF(
	pipe *bufio.Reader,
	locations []nodeLoc,
	jobs chan<- wayJob,
	decodeErr chan<- error,
) {
	var firstWay bool
	nodesRead := 0
	lastLog := 0

	for {
		data, err := readBlob(pipe)
		if err == io.EOF {
			break
		}
		if err != nil {
			decodeErr <- fmt.Errorf("read blob: %w", err)
			return
		}
		if data == nil {
			continue // non-data block, skipped
		}

		var pb OSMPBF.PrimitiveBlock
		if err := proto.Unmarshal(data, &pb); err != nil {
			decodeErr <- fmt.Errorf("unmarshal primitive block: %w", err)
			return
		}

		// 1) Extract all node locations from this block
		nodesRead = extractLocations(&pb, locations, nodesRead)

		// Progress logging
		if nodesRead-lastLog >= 1_000_000 {
			logf("  read %d nodes...", nodesRead)
			lastLog = nodesRead
		}

		// 2) Extract and send all ways from this block
		for _, pg := range pb.GetPrimitivegroup() {
			for _, w := range pg.GetWays() {
				refs := w.GetRefs()
				nodeIDs := make([]int64, len(refs))
				var acc int64
				for i := range refs {
					acc = refs[i] + acc
					nodeIDs[i] = acc
				}
				if !firstWay {
					firstWay = true
					logf("  read %d nodes, starting way processing...", nodesRead)
				}
				jobs <- wayJob{NodeIDs: nodeIDs}
			}
		}
	}

	decodeErr <- nil
	close(jobs)
}

// pbfNodeCount queries osmium fileinfo for the exact number of nodes in a PBF
// file. This lets the caller pre-allocate an exact-sized node location array.
func pbfNodeCount(pbfPath string) (int, error) {
	cmd := exec.Command("osmium", "fileinfo", "-e", "-j", pbfPath)
	out, err := cmd.Output()
	if err != nil {
		return 0, fmt.Errorf("osmium fileinfo: %w", err)
	}
	var info struct {
		Data struct {
			Count struct {
				Nodes int `json:"nodes"`
			} `json:"count"`
		} `json:"data"`
	}
	if err := json.Unmarshal(out, &info); err != nil {
		return 0, fmt.Errorf("parse osmium fileinfo output: %w", err)
	}
	return info.Data.Count.Nodes, nil
}
