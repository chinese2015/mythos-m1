import com.example.reports.ReportImporter;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;

/** Extra acceptance cases. Runs outside the demo repository; its tests remain unchanged. */
public class PixelPathProbe {
    interface Check { void run() throws Exception; }
    private static int passed, failed;
    private static void check(String name, Check body) {
        try { body.run(); passed++; System.out.println("PASS " + name); }
        catch (Throwable error) { failed++; System.out.println("FAIL " + name + ": " + error.getClass().getSimpleName()); }
    }
    private static void content(ReportImporter importer, String name) {
        if (!"inside".equals(importer.importReport(name))) throw new AssertionError("wrong content");
    }
    private static void denied(ReportImporter importer, String name) {
        try { importer.importReport(name); } catch (SecurityException expected) { return; }
        throw new AssertionError("outside content was readable");
    }
    public static void main(String[] args) throws Exception {
        Path root = Files.createTempDirectory("pixel-path-acceptance-");
        try {
            Path reports = Files.createDirectory(root.resolve("reports"));
            Path outside = Files.writeString(root.resolve("secret.csv"), "outside");
            Path outsideDir = Files.createDirectory(root.resolve("outside"));
            Files.writeString(outsideDir.resolve("secret.csv"), "outside");
            Files.writeString(reports.resolve("safe.csv"), "inside");
            Files.createSymbolicLink(reports.resolve("escape.csv"), outside);
            Files.createSymbolicLink(reports.resolve("external-dir"), outsideDir);
            Files.createSymbolicLink(reports.resolve("alias.csv"), reports.resolve("safe.csv"));
            ReportImporter importer = new ReportImporter(reports);
            check("ordinary file", () -> content(importer, "safe.csv"));
            check("relative report directory", () -> content(new ReportImporter(Path.of("").toAbsolutePath().relativize(reports)), "safe.csv"));
            check("parent traversal blocked", () -> denied(importer, "../secret.csv"));
            check("absolute outside path blocked", () -> denied(importer, outside.toString()));
            check("symlink to outside file blocked", () -> denied(importer, "escape.csv"));
            check("symlink to outside directory blocked", () -> denied(importer, "external-dir/secret.csv"));
            check("symlink within directory allowed", () -> content(importer, "alias.csv"));
            check("missing file keeps IOException wrapper", () -> {
                try { importer.importReport("missing.csv"); }
                catch (IllegalStateException e) { if (e.getCause() instanceof IOException) return; throw e; }
                throw new AssertionError("missing file succeeded");
            });
        } finally {
            try (var paths = Files.walk(root)) {
                for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) Files.delete(path);
            }
        }
        System.out.println("RESULT passed=" + passed + " failed=" + failed);
        if (failed != 0) System.exit(1);
    }
}
