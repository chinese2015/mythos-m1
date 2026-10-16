# Maven cache seed

The sandbox image includes a Maven local repository at `/opt/m2-seed`. Candidate workspaces receive a copy as their Maven cache so `mvn -o clean verify` can run without network access.

`runtime/seed-build-cache.sh` creates that cache from a fresh temporary project and a fresh Maven local repository. The seed project uses Java 17, JUnit Jupiter 5.10.2, H2 2.2.224, and Surefire 3.2.5. The Maven clean, resources, compiler, and jar plugins are resolved through Maven's normal lifecycle defaults, matching demo projects that do not pin those versions. Its harmless JUnit test opens an in-memory H2 database. Since Maven runs `clean verify`, the generated repository includes the plugins and transitive dependencies needed for that lifecycle as well as the test dependencies.

Run the script on a host with Maven, Java 17, and network access to the configured Maven repositories:

```sh
./runtime/seed-build-cache.sh
```

The script uses an isolated temporary local repository, then replaces `runtime/m2-seed/repository` with its resolved artifacts. The nested `repository/` directory matches the existing image contract. It removes Maven's host-specific repository-origin and stale-update markers so offline builds can use those artifacts with the image's repository settings. It does not reuse a developer's `~/.m2` or copy the temporary project's `target` directory. Build the sandbox image after seeding so Docker packages that directory.

To validate the packaged seed, copy it into a fresh container and run the seed fixture or a representative Maven project with `mvn --offline clean verify`. Do not validate by relying on an already-warmed candidate workspace: its private Maven cache can hide omissions in the image seed.
