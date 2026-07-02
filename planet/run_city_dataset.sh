#!/bin/bash
set -euo pipefail

# -----------------------------------------------------------------------------
# City Dataset Builder
#
# Builds a full offline city-road dataset from:
#   - per-city GeoJSON boundaries produced by run_boundaries.sh
#   - source region .osm.pbf files
#   - regions.txt listing regions to process
#
# Outputs under DATASET_DIR:
#   - cities-manifest.json
#   - discovery-index.json
#   - build-metadata.json
#   - outlines/<city_id>.json
#   - city-road-cells/<shard>/<city_id>.bin
#   - region-build-metadata/<region>.json
#
# This script delegates the heavy lifting to the native Go city_road_cells_assigner
# binary and handles:
#   - environment/config normalization
#   - input validation
#   - optional upload to R2
#   - top-level pipeline summary
# -----------------------------------------------------------------------------

if [ -n "${DEBUG:-}" ]; then
  set -x
fi

echo "=== City Dataset Builder ==="
echo "User: $(whoami)"
echo "Workdir: $(pwd)"
echo "Started: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"

# -----------------------------------------------------------------------------
# Config
# -----------------------------------------------------------------------------
SOURCE_DIR=${SOURCE_DIR:-"/sources"}
WORK_DIR=${WORK_DIR:-"/tmp/work-city-dataset"}
OUTPUT_DIR=${OUTPUT_DIR:-"/output"}
CITIES_DIR=${CITIES_DIR:-"$OUTPUT_DIR/cities"}
DATASET_DIR=${DATASET_DIR:-"$OUTPUT_DIR/city-dataset"}
REGIONS_FILE=${REGIONS_FILE:-""}
ASSIGNER_BIN=${ASSIGNER_BIN:-"/planetiler/city_road_cells_assigner"}


BUCKET_SIZE_DEG=${BUCKET_SIZE_DEG:-"0.25"}
OUTLINE_TOLERANCE_DEG=${OUTLINE_TOLERANCE_DEG:-"0.0015"}
CELL_SIZE_METERS=${CELL_SIZE_METERS:-"50"}
PRETTY_JSON=${PRETTY_JSON:-"0"}
SKIP_ROAD_CELLS=${SKIP_ROAD_CELLS:-"0"}

R2_BUCKET=${R2_BUCKET:-""}
R2_ENDPOINT=${R2_ENDPOINT:-""}
AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID:-""}
AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY:-""}

MANIFEST_PATH="$DATASET_DIR/cities-manifest.json"
DISCOVERY_INDEX_PATH="$DATASET_DIR/discovery-index.json"
BUILD_METADATA_PATH="$DATASET_DIR/build-metadata.json"
ROAD_CELLS_DIR="$DATASET_DIR/city-road-cells"
OUTLINES_DIR="$DATASET_DIR/outlines"
REGION_METADATA_DIR="$DATASET_DIR/region-build-metadata"

mkdir -p "$WORK_DIR"
mkdir -p "$DATASET_DIR"
mkdir -p "$ROAD_CELLS_DIR"
mkdir -p "$OUTLINES_DIR"
mkdir -p "$REGION_METADATA_DIR"

# -----------------------------------------------------------------------------
# Tool checks
# -----------------------------------------------------------------------------
MISSING_TOOLS=0
for tool in find sed awk date; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "❌ Required tool not found: $tool"
    MISSING_TOOLS=1
  fi
done

# Check the Go assigner binary separately (absolute path, not a PATH lookup)
if [ ! -x "$ASSIGNER_BIN" ]; then
  echo "❌ Required binary not found or not executable: $ASSIGNER_BIN"
  MISSING_TOOLS=1
fi

if [ "$SKIP_ROAD_CELLS" != "1" ]; then
  for tool in osmium; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      echo "❌ Required tool not found for road-cell build: $tool"
      MISSING_TOOLS=1
    fi
  done
fi

if [ "$MISSING_TOOLS" -eq 1 ]; then
  echo "Aborting. Install missing tools before running."
  exit 1
fi
echo "✅ All required tools available"

# -----------------------------------------------------------------------------
# Input validation
# -----------------------------------------------------------------------------
if [ ! -d "$CITIES_DIR" ]; then
  echo "❌ Cities directory not found: $CITIES_DIR"
  echo "   Run the boundary pipeline first so per-city GeoJSON files exist."
  exit 1
fi

REGIONS_LIST_FILE="$WORK_DIR/regions_to_process.txt"
if [ -n "$REGIONS_FILE" ] && [ -f "$REGIONS_FILE" ]; then
  echo "Using provided regions file: $REGIONS_FILE"
  cp "$REGIONS_FILE" "$REGIONS_LIST_FILE"
elif [ -f "/planetiler/regions.txt" ]; then
  echo "Using bundled regions file: /planetiler/regions.txt"
  cp "/planetiler/regions.txt" "$REGIONS_LIST_FILE"
else
  if [ "$SKIP_ROAD_CELLS" = "1" ]; then
    echo "⚠️  No regions file provided. Continuing because SKIP_ROAD_CELLS=1."
    : > "$REGIONS_LIST_FILE"
  else
    echo "❌ No regions file provided. A full dataset build requires a regions list."
    echo "   Provide REGIONS_FILE or bundle /planetiler/regions.txt in the image."
    exit 1
  fi
fi

REGION_COUNT=$(grep -vE '^\s*($|#)' "$REGIONS_LIST_FILE" | wc -l | tr -d ' ')

if [ "$SKIP_ROAD_CELLS" != "1" ] && [ "$REGION_COUNT" -eq 0 ]; then
  echo "❌ Regions file is empty. Road-cell generation requires at least one region entry."
  exit 1
fi

if [ "$SKIP_ROAD_CELLS" != "1" ]; then
  if [ ! -d "$SOURCE_DIR" ]; then
    echo "❌ Source directory not found: $SOURCE_DIR"
    echo "   This pipeline needs source region .osm.pbf files to build road cells."
    exit 1
  fi
fi

echo "📦 Input cities dir:      $CITIES_DIR"
echo "📦 Source PBF dir:        $SOURCE_DIR"
echo "📦 Output dataset dir:    $DATASET_DIR"
echo "📦 Regions file:          $REGIONS_LIST_FILE"

# -----------------------------------------------------------------------------
# Build dataset
# -----------------------------------------------------------------------------
BUILD_START=$(date +%s)

GO_ARGS=(
  --cities-dir "$CITIES_DIR"
  --regions-file "$REGIONS_LIST_FILE"
  --sources-dir "$SOURCE_DIR"
  --output-dir "$DATASET_DIR"
  --bucket-size-deg "$BUCKET_SIZE_DEG"
  --outline-tolerance-deg "$OUTLINE_TOLERANCE_DEG"
  --cell-size-meters "$CELL_SIZE_METERS"
  --manifest-name "$(basename "$MANIFEST_PATH")"
  --discovery-index-name "$(basename "$DISCOVERY_INDEX_PATH")"
  --build-metadata-name "$(basename "$BUILD_METADATA_PATH")"
)

if [ "$PRETTY_JSON" = "1" ]; then
  GO_ARGS+=(--pretty)
fi

if [ "$SKIP_ROAD_CELLS" = "1" ]; then
  GO_ARGS+=(--skip-road-cells)
fi

if [ "${RESUME:-0}" = "1" ]; then
  GO_ARGS+=(--resume)
fi

echo ""
echo "Building city dataset artifacts..."
echo "  Manifest path:       $MANIFEST_PATH"
echo "  Discovery index:     $DISCOVERY_INDEX_PATH"
echo "  Build metadata:      $BUILD_METADATA_PATH"
echo "  Road cells dir:      $ROAD_CELLS_DIR"
echo "  Outlines dir:        $OUTLINES_DIR"
echo "  Region metadata dir: $REGION_METADATA_DIR"
echo ""

"$ASSIGNER_BIN" "${GO_ARGS[@]}"

# -----------------------------------------------------------------------------
# Validate expected outputs
# -----------------------------------------------------------------------------
if [ ! -f "$MANIFEST_PATH" ]; then
  echo "❌ Expected manifest was not created: $MANIFEST_PATH"
  exit 1
fi

if [ ! -f "$DISCOVERY_INDEX_PATH" ]; then
  echo "❌ Expected discovery index was not created: $DISCOVERY_INDEX_PATH"
  exit 1
fi

if [ ! -f "$BUILD_METADATA_PATH" ]; then
  echo "❌ Expected build metadata was not created: $BUILD_METADATA_PATH"
  exit 1
fi

BUILD_END=$(date +%s)
BUILD_ELAPSED=$((BUILD_END - BUILD_START))
BUILD_MINUTES=$((BUILD_ELAPSED / 60))
BUILD_SECONDS=$((BUILD_ELAPSED % 60))

ROAD_CELL_FILE_COUNT=$(find "$ROAD_CELLS_DIR" -type f -name '*.bin' 2>/dev/null | wc -l | tr -d ' ')
OUTLINE_FILE_COUNT=$(find "$OUTLINES_DIR" -type f -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
REGION_METADATA_FILE_COUNT=$(find "$REGION_METADATA_DIR" -type f -name '*.json' 2>/dev/null | wc -l | tr -d ' ')

if [ "$SKIP_ROAD_CELLS" != "1" ]; then
  if [ "$ROAD_CELL_FILE_COUNT" -eq 0 ]; then
    echo "❌ Dataset build produced zero road-cell blobs. Treating this as a failed build."
    exit 1
  fi

  if [ "$REGION_METADATA_FILE_COUNT" -eq 0 ]; then
    echo "❌ Dataset build produced no region metadata files. Treating this as a failed build."
    exit 1
  fi
fi

echo "✅ Dataset build complete in ${BUILD_MINUTES}m ${BUILD_SECONDS}s"
echo "   Manifest:             $MANIFEST_PATH"
echo "   Discovery index:      $DISCOVERY_INDEX_PATH"
echo "   Build metadata:       $BUILD_METADATA_PATH"
echo "   Road cell blobs:      $ROAD_CELL_FILE_COUNT file(s)"
echo "   Outline files:        $OUTLINE_FILE_COUNT file(s)"
echo "   Region metadata:      $REGION_METADATA_FILE_COUNT file(s)"

# -----------------------------------------------------------------------------
# Optional upload
# -----------------------------------------------------------------------------
if [ -n "$R2_BUCKET" ] && [ -n "$R2_ENDPOINT" ] && [ -n "$AWS_ACCESS_KEY_ID" ] && [ -n "$AWS_SECRET_ACCESS_KEY" ]; then
  if ! command -v aws >/dev/null 2>&1; then
    echo "❌ aws CLI is required for upload but was not found"
    exit 1
  fi

  echo ""
  echo "Uploading city dataset artifacts to R2..."
  echo "  Bucket:   $R2_BUCKET"
  echo "  Endpoint: $R2_ENDPOINT"

  aws --endpoint-url="$R2_ENDPOINT" s3 cp \
    "$MANIFEST_PATH" \
    "s3://$R2_BUCKET/city-dataset/cities-manifest.json"

  aws --endpoint-url="$R2_ENDPOINT" s3 cp \
    "$DISCOVERY_INDEX_PATH" \
    "s3://$R2_BUCKET/city-dataset/discovery-index.json"

  aws --endpoint-url="$R2_ENDPOINT" s3 cp \
    "$BUILD_METADATA_PATH" \
    "s3://$R2_BUCKET/city-dataset/build-metadata.json"

  aws --endpoint-url="$R2_ENDPOINT" s3 sync \
    "$ROAD_CELLS_DIR" \
    "s3://$R2_BUCKET/city-dataset/city-road-cells/"

  aws --endpoint-url="$R2_ENDPOINT" s3 sync \
    "$OUTLINES_DIR" \
    "s3://$R2_BUCKET/city-dataset/outlines/"

  aws --endpoint-url="$R2_ENDPOINT" s3 sync \
    "$REGION_METADATA_DIR" \
    "s3://$R2_BUCKET/city-dataset/region-build-metadata/"

  echo "✅ Upload complete"
else
  echo ""
  echo "⚠️  R2 credentials not set — skipping upload."
  echo "   Artifacts are available locally in $DATASET_DIR"
fi

echo ""
echo "========================================"
echo "✅ City dataset pipeline complete"
echo "   Regions listed:       $REGION_COUNT"
echo "   Road cell blobs:      $ROAD_CELL_FILE_COUNT"
echo "   Output dataset dir:   $DATASET_DIR"
echo "   Total time:           ${BUILD_MINUTES}m ${BUILD_SECONDS}s"
echo "========================================"
