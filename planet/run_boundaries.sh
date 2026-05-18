#!/bin/bash
set -e

# Enable verbose debugging if DEBUG is set
if [ -n "$DEBUG" ]; then
  set -x
fi

# Incremental mode: skip regions/cities that already exist
# Set INCREMENTAL=1 to enable, or pass --incremental flag
INCREMENTAL=${INCREMENTAL:-0}
if [[ "$1" == "--incremental" ]] || [[ "$2" == "--incremental" ]]; then
  INCREMENTAL=1
fi

# Force mode: regenerate everything even if it exists
# Set FORCE=1 to enable, or pass --force flag
FORCE=${FORCE:-0}
if [[ "$1" == "--force" ]] || [[ "$2" == "--force" ]]; then
  FORCE=1
fi

echo "=== Boundary Processor ==="
echo "User: $(whoami)"
echo "Workdir: $(pwd)"
echo "Started: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"

# -------------------------------------------
# Tool availability checks
# -------------------------------------------
MISSING_TOOLS=0
for tool in osmium python3 tippecanoe; do
  if ! command -v "$tool" &>/dev/null; then
    echo "❌ Required tool not found: $tool"
    MISSING_TOOLS=1
  fi
done
if [ "$MISSING_TOOLS" -eq 1 ]; then
  echo "Aborting. Install missing tools before running."
  exit 1
fi
echo "✅ All required tools available"

if [ "$INCREMENTAL" -eq 1 ]; then
  echo "📦 INCREMENTAL MODE: Will skip already-processed regions and existing city files"
elif [ "$FORCE" -eq 1 ]; then
  echo "🔄 FORCE MODE: Will regenerate all regions and cities"
fi

# -------------------------------------------
# Directories
# -------------------------------------------
SOURCE_DIR=${SOURCE_DIR:-"/sources"}
WORK_DIR=${WORK_DIR:-"/tmp/work"}
OUTPUT_DIR=${OUTPUT_DIR:-"/output"}

mkdir -p "$WORK_DIR"
mkdir -p "$OUTPUT_DIR/cities"
mkdir -p "$OUTPUT_DIR/lookup"

# -------------------------------------------
# Regions list
# -------------------------------------------
REGIONS_LIST_FILE="$WORK_DIR/regions_to_process.txt"

if [ -n "$REGIONS_FILE" ] && [ -f "$REGIONS_FILE" ]; then
  echo "Using provided regions file: $REGIONS_FILE"
  cp "$REGIONS_FILE" "$REGIONS_LIST_FILE"
else
  echo "Using default regions list."
  cat <<EOF > "$REGIONS_LIST_FILE"
north-america|https://download.geofabrik.de/north-america-latest.osm.pbf|north-america.pmtiles
EOF
fi

# -------------------------------------------
# R2 Configuration (optional)
# -------------------------------------------
R2_BUCKET=${R2_BUCKET:-""}
R2_ENDPOINT=${R2_ENDPOINT:-""}
AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID:-""}
AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY:-""}

PROCESSED=0
SUCCESSFUL=0
FAILED=0
TOTAL_CITIES=0
GLOBAL_GEOJSON_FILES=()

PIPELINE_START=$(date +%s)

# -------------------------------------------
# Process each region
# -------------------------------------------
while IFS= read -r line || [ -n "$line" ]; do
  # Trim whitespace
  line=$(echo "$line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')

  # Skip empty lines and comments
  if [[ -z "$line" ]] || [[ "$line" == \#* ]]; then
    continue
  fi

  REGION_NAME=$(echo "$line" | cut -d'|' -f1 | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  PBF_URL=$(echo "$line" | cut -d'|' -f2 | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  ROAD_TILES_FILENAME=$(echo "$line" | cut -d'|' -f3 | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')

  if [[ -z "$REGION_NAME" ]]; then
    echo "⚠️  Skipping invalid line: '$line'"
    continue
  fi

  # Default road tiles filename if not specified in regions.txt
  if [[ -z "$ROAD_TILES_FILENAME" ]]; then
    ROAD_TILES_FILENAME="${REGION_NAME}.pmtiles"
  fi

  PROCESSED=$((PROCESSED+1))
  REGION_START=$(date +%s)
  echo ""
  echo "[$PROCESSED] Processing Region: $REGION_NAME"
  echo "    Road tiles file: $ROAD_TILES_FILENAME"
  echo "========================================"

  # Check if this region was already processed (incremental mode)
  GEOJSON_SEQ="$WORK_DIR/${REGION_NAME}-cities.geojsonseq"
  GEOJSON_SEQ_CACHED="$OUTPUT_DIR/.cache/${REGION_NAME}-cities.geojsonseq"

  if [ "$INCREMENTAL" -eq 1 ] && [ "$FORCE" -eq 0 ]; then
    # Check for cached geojsonseq from previous run
    if [ -f "$GEOJSON_SEQ_CACHED" ]; then
      echo "  ⏭️  Skipping region (cached geojsonseq exists): $GEOJSON_SEQ_CACHED"
      # Copy cached file to work dir for tippecanoe merge later
      cp "$GEOJSON_SEQ_CACHED" "$GEOJSON_SEQ"
      GLOBAL_GEOJSON_FILES+=("$GEOJSON_SEQ")
      SUCCESSFUL=$((SUCCESSFUL+1))
      continue
    fi
  fi

  # 1. Locate Input PBF
  INPUT_PBF="$SOURCE_DIR/${REGION_NAME}-latest.osm.pbf"

  if [ -f "$INPUT_PBF" ]; then
    echo "✅ Found local file: $INPUT_PBF ($(du -h "$INPUT_PBF" | cut -f1))"
  else
    echo "⚠️  Local file not found at $INPUT_PBF"
    if [ -n "$PBF_URL" ]; then
      echo "⬇️  Attempting download from $PBF_URL..."
      INPUT_PBF="$WORK_DIR/${REGION_NAME}-latest.osm.pbf"
      if ! wget -nv -O "$INPUT_PBF" "$PBF_URL"; then
        echo "❌ Failed to download $PBF_URL"
        FAILED=$((FAILED+1))
        continue
      fi
    else
      echo "❌ No URL provided and no local file found."
      FAILED=$((FAILED+1))
      continue
    fi
  fi

  # Intermediate files
  BOUNDARIES_PBF="$WORK_DIR/${REGION_NAME}-boundaries.osm.pbf"
  CITIES_PBF="$WORK_DIR/${REGION_NAME}-cities.osm.pbf"
  GEOJSON_SEQ_RAW="$WORK_DIR/${REGION_NAME}-cities-raw.geojsonseq"
  GEOJSON_SEQ="$WORK_DIR/${REGION_NAME}-cities.geojsonseq"

  # 2. Extract Administrative Boundaries
  echo "  Step 1/5: Extracting administrative boundaries..."
  if ! osmium tags-filter "$INPUT_PBF" \
       w/boundary=administrative r/boundary=administrative \
       -o "$BOUNDARIES_PBF" --overwrite; then
    echo "❌ Failed to extract boundaries for $REGION_NAME"
    FAILED=$((FAILED+1))
    continue
  fi
  echo "    → $(du -h "$BOUNDARIES_PBF" | cut -f1)"

  # 3. Filter for Cities (Admin Levels 4-8)
  # Different countries use different admin_levels for cities:
  #   - admin_level=4: City-states (Berlin, Hamburg, Bremen in Germany;
  #                    Luxembourg; Singapore-equivalent structures)
  #   - admin_level=5: Major metro areas (NYC)
  #   - admin_level=6: Independent cities (German Kreisfreie Städte like Munich),
  #                    US city-counties (San Francisco), UK boroughs
  #   - admin_level=7: Some subdivisions
  #   - admin_level=8: Most cities/municipalities (default)
  # We keep extraction broad so we do not miss legitimate city/state hybrids
  # or regions where municipalities are mapped at unusual admin_levels.
  # A stricter heuristic is applied after GeoJSON export to remove obvious
  # non-city boundaries before city files are written.
  echo "  Step 2/5: Filtering for admin_level=4,5,6,7,8 (cities/municipalities)..."
  if ! osmium tags-filter "$BOUNDARIES_PBF" \
       admin_level=4 admin_level=5 admin_level=6 admin_level=7 admin_level=8 \
       -o "$CITIES_PBF" --overwrite; then
    echo "❌ Failed to filter cities for $REGION_NAME"
    FAILED=$((FAILED+1))
    rm -f "$BOUNDARIES_PBF"
    continue
  fi
  echo "    → $(du -h "$CITIES_PBF" | cut -f1)"

  # 4. Export to GeoJSON Sequence
  echo "  Step 3/5: Exporting to GeoJSON Sequence (polygons only)..."
  if ! osmium export "$CITIES_PBF" \
       --geometry-types=polygon \
       --add-unique-id=type_id \
       -f geojsonseq \
       --overwrite \
       -o "$GEOJSON_SEQ_RAW"; then
    echo "❌ Failed to export GeoJSON for $REGION_NAME"
    FAILED=$((FAILED+1))
    rm -f "$BOUNDARIES_PBF" "$CITIES_PBF"
    continue
  fi

  if [ ! -s "$GEOJSON_SEQ_RAW" ]; then
    echo "⚠️  Warning: GeoJSON sequence file is empty — no cities found for $REGION_NAME"
    rm -f "$BOUNDARIES_PBF" "$CITIES_PBF" "$GEOJSON_SEQ_RAW"
    SUCCESSFUL=$((SUCCESSFUL+1))
    continue
  fi

  RAW_FEATURE_COUNT=$(wc -l < "$GEOJSON_SEQ_RAW" | tr -d ' ')
  echo "    → $(du -h "$GEOJSON_SEQ_RAW" | cut -f1) ($RAW_FEATURE_COUNT features)"

  # 5. Enrich GeoJSON Sequence
  # Inject osm_id (from feature.id) and road_tiles (from regions.txt) into properties.
  # This is critical: vector tile format (MVT) only supports integer feature IDs,
  # but osmium produces string IDs like "relation/12345". Tippecanoe drops these.
  # By copying the ID into properties, the client can retrieve it from the vector tile
  # and use it to fetch the full city boundary GeoJSON file.
  #
  # Also filters out obvious non-city boundaries that slip through due to the
  # global admin_level mismatch problem. The filter stays broad at extraction
  # time, then uses a conservative heuristic here:
  #   - admin_level=8 and most admin_level=6 features are the baseline
  #   - admin_level=4,5,7 need explicit urban signals or a compact bbox
  #   - obvious electoral / district / province / county style boundaries are dropped
  echo "  Step 4/5: Enriching and filtering features..."
  if ! python3 -c "
import json, re, sys

road_tiles = sys.argv[1]
count = 0
skipped = 0
errors = 0
missing_ids = 0
skip_reasons = {}
accepted_levels = {}

MAX_CITY_BBOX_SPAN_DEG = 1.75
VALID_ADMIN_LEVELS = {'4', '5', '6', '7', '8'}
POSITIVE_PLACE_VALUES = {'city', 'town', 'municipality'}
NEGATIVE_PLACE_VALUES = {
    'suburb',
    'neighbourhood',
    'neighborhood',
    'quarter',
    'borough',
    'district',
    'village',
    'hamlet',
    'isolated_dwelling',
}
NEGATIVE_BOUNDARY_VALUES = {'census', 'electoral', 'school_district', 'fire_district'}

# osmium --add-unique-id=type_id produces: n123, w456, r789, a111
# Normalize to: node_123, way_456, relation_789, area_111
TYPE_ID_RE = re.compile(r'^([nwra])(\d+)$')
TYPE_PREFIX = {'n': 'node', 'w': 'way', 'r': 'relation', 'a': 'area'}

HARD_EXCLUDE_PATTERNS = [
    re.compile(r'\bcouncil\s+district\b', re.I),
    re.compile(r'\bcity\s+council\b', re.I),
    re.compile(r'\belectoral\s+district\b', re.I),
    re.compile(r'\bward\s+\d+\b', re.I),
    re.compile(r'\b\d+(st|nd|rd|th)?\s+ward\b', re.I),
    re.compile(r'\bprecinct\b', re.I),
    re.compile(r'\bvoting\s+district\b', re.I),
    re.compile(r'\bschool\s+district\b', re.I),
    re.compile(r'\bfire\s+district\b', re.I),
    re.compile(r'\bwater\s+district\b', re.I),
    re.compile(r'\bsupervisorial\s+district\b', re.I),
    re.compile(r'\bcommissioner\s+district\b', re.I),
    re.compile(r'\bcensus\s+tract\b', re.I),
    re.compile(r'\bneighbou?rhood\s+council\b', re.I),
]

BROAD_ADMIN_PATTERNS = [
    re.compile(r'\bcounty\b', re.I),
    re.compile(r'\bparish\b', re.I),
    re.compile(r'\bprovince\b', re.I),
    re.compile(r'\bstate\b', re.I),
    re.compile(r'\bregion\b', re.I),
    re.compile(r'\bprefecture\b', re.I),
    re.compile(r'\bgovernorate\b', re.I),
    re.compile(r'\boblast\b', re.I),
    re.compile(r'\bkrai\b', re.I),
    re.compile(r'\braion\b', re.I),
    re.compile(r'\bdepartment\b', re.I),
    re.compile(r'\bcanton\b', re.I),
    re.compile(r'\barrondissement\b', re.I),
    re.compile(r'\bmunicipal\s+district\b', re.I),
    re.compile(r'\brural\s+municipality\b', re.I),
    re.compile(r'\btownship\b', re.I),
]


def text_value(value):
    if isinstance(value, str):
        return value.strip()
    if value is None:
        return ''
    return str(value).strip()


def truthy_flag(value):
    text = text_value(value).lower()
    return bool(text) and text not in {'0', 'false', 'no', 'none'}


def combined_name_text(props):
    values = []
    for key in ('name', 'official_name', 'short_name'):
        text = text_value(props.get(key))
        if text:
            values.append(text)
    return ' | '.join(values)


def iter_geometry_points(geometry):
    gtype = geometry.get('type')
    coords = geometry.get('coordinates')
    if gtype == 'Polygon' and isinstance(coords, list):
        polygons = [coords]
    elif gtype == 'MultiPolygon' and isinstance(coords, list):
        polygons = coords
    else:
        return

    for polygon in polygons:
        if not isinstance(polygon, list):
            continue
        for ring in polygon:
            if not isinstance(ring, list):
                continue
            for point in ring:
                if (
                    isinstance(point, list)
                    and len(point) >= 2
                    and isinstance(point[0], (int, float))
                    and isinstance(point[1], (int, float))
                ):
                    yield float(point[0]), float(point[1])


def bbox_span_deg(geometry):
    min_lng = 180.0
    max_lng = -180.0
    min_lat = 90.0
    max_lat = -90.0
    found = False

    for lng, lat in iter_geometry_points(geometry):
        found = True
        if lng < min_lng:
            min_lng = lng
        if lng > max_lng:
            max_lng = lng
        if lat < min_lat:
            min_lat = lat
        if lat > max_lat:
            max_lat = lat

    if not found:
        return None

    return max_lat - min_lat, max_lng - min_lng


def matches_any(patterns, text):
    return any(pattern.search(text) for pattern in patterns)


def should_include(props, geometry):
    admin_level = text_value(props.get('admin_level'))
    if admin_level not in VALID_ADMIN_LEVELS:
        return False, 'unsupported_admin_level'

    names = combined_name_text(props)
    if not names:
        return False, 'missing_name'

    boundary = text_value(props.get('boundary')).lower()
    if boundary in NEGATIVE_BOUNDARY_VALUES:
        return False, f'negative_boundary:{boundary}'

    place = text_value(props.get('place')).lower()
    if place in NEGATIVE_PLACE_VALUES:
        return False, f'negative_place:{place}'

    if matches_any(HARD_EXCLUDE_PATTERNS, names):
        return False, 'hard_exclude_pattern'

    border_type = text_value(props.get('border_type')).lower()
    strong_urban_signal = (
        place in POSITIVE_PLACE_VALUES
        or border_type == 'city'
        or truthy_flag(props.get('capital'))
    )
    broad_admin_signal = matches_any(BROAD_ADMIN_PATTERNS, names)

    spans = bbox_span_deg(geometry)
    compact_bbox = False
    if spans is not None:
        lat_span, lng_span = spans
        compact_bbox = lat_span <= MAX_CITY_BBOX_SPAN_DEG and lng_span <= MAX_CITY_BBOX_SPAN_DEG

    if admin_level in {'8', '6'}:
        if broad_admin_signal and not strong_urban_signal and not compact_bbox:
            return False, 'broad_admin_without_urban_signal'
        return True, f'accept_admin_level_{admin_level}'

    if strong_urban_signal:
        return True, f'accept_strong_urban_level_{admin_level}'
    if broad_admin_signal:
        return False, 'broad_admin_needs_urban_signal'
    if compact_bbox:
        return True, f'accept_compact_bbox_level_{admin_level}'
    return False, 'needs_urban_signal_or_compact_bbox'


for line in sys.stdin:
    line = line.strip()
    rs = ''
    if line.startswith('\x1e'):
        rs = '\x1e'
        line = line[1:]
    if not line:
        continue
    try:
        feat = json.loads(line)
        props = feat.setdefault('properties', {})
        geometry = feat.get('geometry')
        if not isinstance(geometry, dict):
            skipped += 1
            skip_reasons['invalid_geometry'] = skip_reasons.get('invalid_geometry', 0) + 1
            continue

        include, reason = should_include(props, geometry)
        if not include:
            skipped += 1
            skip_reasons[reason] = skip_reasons.get(reason, 0) + 1
            continue

        admin_level = text_value(props.get('admin_level'))
        accepted_levels[admin_level] = accepted_levels.get(admin_level, 0) + 1

        # Extract and normalize osm_id from feature-level id
        # Formats: slash ('relation/12345'), type_id ('a1455258288'), numeric (12345)
        fid = feat.get('id')
        if isinstance(fid, str) and '/' in fid:
            props['osm_id'] = fid.replace('/', '_')
        elif isinstance(fid, str):
            m = TYPE_ID_RE.match(fid)
            if m:
                props['osm_id'] = f'{TYPE_PREFIX[m.group(1)]}_{m.group(2)}'
            elif fid:
                props['osm_id'] = fid
            else:
                missing_ids += 1
                if missing_ids <= 3:
                    print(f'  ⚠️  Feature missing id field (keys: {list(feat.keys())})', file=sys.stderr)
        elif fid is not None:
            props['osm_id'] = str(fid)
        else:
            missing_ids += 1
            if missing_ids <= 3:
                print(f'  ⚠️  Feature missing id field (keys: {list(feat.keys())})', file=sys.stderr)

        props['road_tiles'] = road_tiles

        sys.stdout.write(rs + json.dumps(feat, ensure_ascii=False) + '\n')
        count += 1
    except Exception as e:
        print(f'  enrich error: {e}', file=sys.stderr)
        errors += 1

print(f'  Enriched {count} features, skipped {skipped} non-city boundaries (errors: {errors})', file=sys.stderr)
if accepted_levels:
    levels = ', '.join(f'admin_level={level}:{accepted_levels[level]}' for level in sorted(accepted_levels))
    print(f'  Accepted by admin level: {levels}', file=sys.stderr)
if skip_reasons:
    top_reasons = sorted(skip_reasons.items(), key=lambda item: (-item[1], item[0]))[:8]
    summary = ', '.join(f'{reason}:{count}' for reason, count in top_reasons)
    print(f'  Top skip reasons: {summary}', file=sys.stderr)
if missing_ids > 0:
    print(f'  ❌ {missing_ids}/{count} features have NO id — city files will use fallback names!', file=sys.stderr)
    print(f'     Ensure osmium export is called with --add-unique-id=type_id', file=sys.stderr)
" "$ROAD_TILES_FILENAME" < "$GEOJSON_SEQ_RAW" > "$GEOJSON_SEQ"; then
    echo "❌ Failed to enrich GeoJSON for $REGION_NAME"
    FAILED=$((FAILED+1))
    rm -f "$BOUNDARIES_PBF" "$CITIES_PBF" "$GEOJSON_SEQ_RAW"
    continue
  fi

  # Clean up raw (un-enriched) version
  rm -f "$GEOJSON_SEQ_RAW"

  FEATURE_COUNT=$(wc -l < "$GEOJSON_SEQ" | tr -d ' ')
  echo "    → $(du -h "$GEOJSON_SEQ" | cut -f1) ($FEATURE_COUNT enriched features)"

  # Add enriched file to list for global lookup generation
  GLOBAL_GEOJSON_FILES+=("$GEOJSON_SEQ")

  # Cache the geojsonseq for future incremental runs
  mkdir -p "$OUTPUT_DIR/.cache"
  cp "$GEOJSON_SEQ" "$GEOJSON_SEQ_CACHED"

  # 6. Split into Individual City GeoJSON Files
  # Count files before split for delta
  CITIES_BEFORE=$(find "$OUTPUT_DIR/cities" -name '*.geojson' 2>/dev/null | wc -l | tr -d ' ')

  echo "  Step 5/5: Splitting into individual city files..."
  SPLIT_FLAGS=""
  if [ "$INCREMENTAL" -eq 1 ] && [ "$FORCE" -eq 0 ]; then
    SPLIT_FLAGS="--skip-existing"
  fi
  if ! python3 /planetiler/split_cities.py $SPLIT_FLAGS "$GEOJSON_SEQ" "$OUTPUT_DIR/cities"; then
    echo "❌ Failed to split cities for $REGION_NAME"
    FAILED=$((FAILED+1))
    rm -f "$BOUNDARIES_PBF" "$CITIES_PBF"
    continue
  fi

  CITIES_AFTER=$(find "$OUTPUT_DIR/cities" -name '*.geojson' 2>/dev/null | wc -l | tr -d ' ')
  REGION_CITIES=$((CITIES_AFTER - CITIES_BEFORE))
  TOTAL_CITIES=$((TOTAL_CITIES + REGION_CITIES))

  # Post-split validation: check for bad fallback filenames
  BAD_NAMES=$(find "$OUTPUT_DIR/cities" -name 'feature_*.geojson' 2>/dev/null | wc -l | tr -d ' ')
  if [ "$BAD_NAMES" -gt 0 ]; then
    echo "  ⚠️  WARNING: $BAD_NAMES files have fallback 'feature_X' names (missing OSM IDs)"
    echo "     This indicates osmium export is not producing feature IDs."
    echo "     Sample bad files:"
    find "$OUTPUT_DIR/cities" -name 'feature_*.geojson' 2>/dev/null | head -5 | sed 's/^/       /'
  fi

  # Clean up intermediate PBFs (keep enriched geojsonseq for tippecanoe)
  rm -f "$BOUNDARIES_PBF" "$CITIES_PBF"

  # If we downloaded the input PBF to WORK_DIR, clean it up
  if [[ "$INPUT_PBF" == "$WORK_DIR"* ]]; then
    rm -f "$INPUT_PBF"
  fi

  REGION_END=$(date +%s)
  REGION_ELAPSED=$((REGION_END - REGION_START))
  echo "  ✅ $REGION_NAME complete: $REGION_CITIES cities in ${REGION_ELAPSED}s"

  SUCCESSFUL=$((SUCCESSFUL+1))

done < "$REGIONS_LIST_FILE"

echo ""
echo "========================================"
echo "Region processing complete."
echo "Regions — Successful: $SUCCESSFUL | Failed: $FAILED"
echo "Total city files: $TOTAL_CITIES"
echo "========================================"

if [ ${#GLOBAL_GEOJSON_FILES[@]} -eq 0 ]; then
  echo "❌ No GeoJSON files generated. Nothing to merge. Exiting."
  exit 1
fi

# -------------------------------------------
# Generate Global Lookup PMTiles
# -------------------------------------------
echo ""
echo "Generating world-lookup.pmtiles from ${#GLOBAL_GEOJSON_FILES[@]} region file(s)..."
WORLD_LOOKUP_PMTILES="$OUTPUT_DIR/lookup/world-lookup.pmtiles"

TIPPECANOE_START=$(date +%s)

# Tippecanoe settings optimized for city boundary lookups:
#   --no-feature-limit: Don't drop features per tile (we need all cities)
#   --no-tile-size-limit: Allow larger tiles to preserve all boundaries
#   --no-tile-compression: Faster reads, slightly larger file
#   --simplification=4: Light simplification to reduce size while keeping shape
#   --detect-shared-borders: Better handling of adjacent city boundaries
#   --coalesce-densest-as-needed: Prefer coalescing over dropping
#   --extend-zooms-if-still-dropping: Add zoom levels rather than drop features
if ! tippecanoe -o "$WORLD_LOOKUP_PMTILES" \
    --force \
    --layer=cities \
    --minimum-zoom=0 --maximum-zoom=12 \
    --no-feature-limit \
    --no-tile-size-limit \
    --simplification=4 \
    --detect-shared-borders \
    --coalesce-densest-as-needed \
    --extend-zooms-if-still-dropping \
    --read-parallel \
    "${GLOBAL_GEOJSON_FILES[@]}"; then
  echo "❌ Failed to generate world-lookup.pmtiles"
  exit 1
fi

TIPPECANOE_END=$(date +%s)
TIPPECANOE_ELAPSED=$((TIPPECANOE_END - TIPPECANOE_START))
echo "✅ Generated $WORLD_LOOKUP_PMTILES ($(du -h "$WORLD_LOOKUP_PMTILES" | cut -f1)) in ${TIPPECANOE_ELAPSED}s"

# -------------------------------------------
# Upload to R2 (only if credentials are set)
# -------------------------------------------
if [ -n "$R2_BUCKET" ] && [ -n "$R2_ENDPOINT" ] && [ -n "$AWS_ACCESS_KEY_ID" ] && [ -n "$AWS_SECRET_ACCESS_KEY" ]; then
  echo ""
  echo "Uploading artifacts to R2..."

  echo "  Uploading world-lookup.pmtiles..."
  if ! aws --endpoint-url="$R2_ENDPOINT" s3 cp "$WORLD_LOOKUP_PMTILES" "s3://$R2_BUCKET/world-lookup.pmtiles"; then
    echo "❌ Upload failed for world-lookup.pmtiles"
    exit 1
  fi

  echo "  Syncing city geometries to s3://$R2_BUCKET/cities/ ..."
  if ! aws --endpoint-url="$R2_ENDPOINT" s3 sync "$OUTPUT_DIR/cities" "s3://$R2_BUCKET/cities/"; then
    echo "❌ Upload failed for city geometries"
    exit 1
  fi

  echo "✅ Upload complete"
else
  echo ""
  echo "⚠️  R2 credentials not set — skipping upload."
  echo "   Artifacts are available locally in $OUTPUT_DIR"
fi

# -------------------------------------------
# Cleanup & Summary
# -------------------------------------------
echo ""
echo "Cleaning up work directory..."
rm -rf "$WORK_DIR"

PIPELINE_END=$(date +%s)
PIPELINE_ELAPSED=$((PIPELINE_END - PIPELINE_START))
PIPELINE_MINUTES=$((PIPELINE_ELAPSED / 60))
PIPELINE_REMAINING_SECONDS=$((PIPELINE_ELAPSED % 60))

echo ""
echo "========================================"
echo "✅ Pipeline Complete"
echo "   Regions processed: $SUCCESSFUL / $PROCESSED"
echo "   City files created: $TOTAL_CITIES"
echo "   Lookup PMTiles:     $OUTPUT_DIR/lookup/world-lookup.pmtiles"
echo "   City GeoJSONs:      $OUTPUT_DIR/cities/"
echo "   Total time:         ${PIPELINE_MINUTES}m ${PIPELINE_REMAINING_SECONDS}s"
echo "========================================"
