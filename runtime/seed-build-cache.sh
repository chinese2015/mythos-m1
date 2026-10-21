#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RUNTIME_DIR=$SCRIPT_DIR
WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/mythos-maven-seed.XXXXXX")
SEED_DIR=$RUNTIME_DIR/m2-seed
STAGED_SEED=$RUNTIME_DIR/.m2-seed.staged.$$

cleanup() {
  rm -rf "$WORK_DIR" "$STAGED_SEED"
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$WORK_DIR/project/src/test/java/org/example/mythos"
cp "$RUNTIME_DIR/cache-seed-pom.xml" "$WORK_DIR/project/pom.xml"
cat > "$WORK_DIR/project/src/test/java/org/example/mythos/SeedSmokeTest.java" <<'EOF'
package org.example.mythos;

import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

class SeedSmokeTest {
    @Test
    void junitAndH2AreAvailable() throws Exception {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:seed;DB_CLOSE_DELAY=-1");
        try (var connection = source.getConnection();
             var statement = connection.createStatement()) {
            statement.execute("select 17");
            try (var rows = statement.getResultSet()) {
                rows.next();
                assertEquals(17, rows.getInt(1));
            }
        }
    }
}
EOF

# An isolated repository makes the result reproducible and prevents user or host
# cache contents from being silently copied into the image.
mkdir -p "$WORK_DIR/repository"
(cd "$WORK_DIR/project" && mvn --batch-mode --no-transfer-progress \
  -Dmaven.repo.local="$WORK_DIR/repository" clean verify)

# Keep the existing image contract: Maven's repository lives below m2-seed/repository.
# Copy only generated local-repository contents, never project output or host cache.
mkdir -p "$STAGED_SEED/repository"
cp -a "$WORK_DIR/repository/." "$STAGED_SEED/repository/"
# Maven records source repository IDs in these markers. Removing them makes
# the verified artifacts portable to offline builds with a different settings.xml.
find "$STAGED_SEED/repository" -type f \
  \( -name _remote.repositories -o -name '*.lastUpdated' \) -delete
rm -rf "$SEED_DIR"
mv "$STAGED_SEED" "$SEED_DIR"
printf 'Seeded %s from isolated clean verify repository (%s files).\n' \
  "$SEED_DIR/repository" "$(find "$SEED_DIR/repository" -type f | wc -l | tr -d ' ')"
