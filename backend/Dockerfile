# ---- build stage ----
FROM ubuntu:24.04 AS build
ENV DEBIAN_FRONTEND=noninteractive
# NOTE: libmariadb-dev is NOT used by the platform (PostgreSQL only). Ubuntu's libdrogon-dev package was
# compiled with MySQL support, so its CMake config requires the MySQL client headers to configure at all.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake ninja-build pkg-config git \
    libdrogon-dev libtrantor-dev libpqxx-dev libpq-dev libjsoncpp-dev libpoppler-cpp-dev \
    libcurl4-openssl-dev libssl-dev uuid-dev zlib1g-dev libbrotli-dev libhiredis-dev libyaml-cpp-dev libsqlite3-dev libmariadb-dev libmariadb-dev-compat \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY CMakeLists.txt ./
COPY src ./src
COPY tests ./tests
COPY migrations ./migrations
RUN cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build build --target acerciae-server

# ---- runtime stage ----
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    libdrogon1t64 libtrantor1 libpqxx-7.8t64 libjsoncpp25 libpoppler-cpp0t64 libcurl4t64 libssl3t64 curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /src/build/acerciae-server /app/acerciae-server
COPY migrations /app/migrations
RUN useradd --system --uid 10001 --home /app acerciae && mkdir -p /data/uploads && chown -R acerciae /data/uploads
ENV MIGRATIONS_DIR=/app/migrations UPLOAD_DIR=/data/uploads HTTP_PORT=8080
EXPOSE 8080
USER acerciae
CMD ["/app/acerciae-server"]
