FROM eclipse-temurin:21-jdk-jammy

# Install dependencies
# osmctools contains osmconvert and osmfilter
# awscli for S3 upload
# osmium-tool for advanced PBF filtering/export
# python3 for boundary enrichment scripts (run_boundaries.sh)
# Go native city_road_cells_assigner for the full dataset pipeline
# build tools for tippecanoe
RUN apt-get update && apt-get install -y \
	wget \
	curl \
	osmctools \
	osmium-tool \
	python3 \
	python3-venv \
	awscli \
	build-essential \
	libsqlite3-dev \
	zlib1g-dev \
	git \
	make \
	g++ \
	golang-go \
	&& rm -rf /var/lib/apt/lists/*



# Build Tippecanoe (Felt version for better PMTiles support)
RUN git clone https://github.com/felt/tippecanoe.git \
	&& cd tippecanoe \
	&& make -j \
	&& make install \
	&& cd .. \
	&& rm -rf tippecanoe

WORKDIR /planetiler

# Download planetiler jar
RUN wget https://github.com/onthegomap/planetiler/releases/download/v0.9.3/planetiler.jar

# Copy the scripts
COPY run_boundaries.sh /planetiler/run_boundaries.sh
COPY run_city_dataset.sh /planetiler/run_city_dataset.sh
COPY regions.txt /planetiler/regions.txt
COPY go.mod /planetiler/go.mod
COPY cmd /planetiler/cmd

RUN cd /planetiler \
	&& go build -o /planetiler/city_road_cells_assigner ./cmd/city_road_cells_assigner \
	&& chmod +x /planetiler/run_boundaries.sh \
	&& chmod +x /planetiler/run_city_dataset.sh \
	&& chmod +x /planetiler/city_road_cells_assigner

# Default command
CMD ["/planetiler/run_city_dataset.sh"]
