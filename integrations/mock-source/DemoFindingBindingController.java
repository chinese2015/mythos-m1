package com.example.mythosdemo.api;

import com.example.mythosdemo.domain.Finding;
import com.example.mythosdemo.domain.FindingRepository;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import org.springframework.http.HttpStatus;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.net.InetAddress;

@RestController
@RequestMapping("/api/findings")
public class DemoFindingBindingController {
    private static final String FINDING_ID = "FND-00016";
    private static final String OWNER_ID = "owner-aster-01";
    private static final String PLACEHOLDER_NAME = "Example multi-user notes view lacks mock tenant scope";
    private static final String INVOICE_FINDING_NAME = "Invoice endpoint exposes another tenant's invoice by ID";
    private static final String OLD_REPOSITORY_ID = "REPO-demo-aster-ui-service";
    private static final String OLD_REPOSITORY_URL = "https://git.example.test/demo/demo-aster-ui-service.git";
    private static final String OLD_BASE_COMMIT = "6a11c9d2e8f34b0a9d5e7c61f2b8a0d4e6c3f1a2";
    private static final String NEW_REPOSITORY_ID = "REPO-demo-tenant-invoice-api";
    private static final String NEW_REPOSITORY_URL = "http://127.0.0.1:3000/demo/demo-tenant-invoice-api.git";
    private static final String NEW_SOURCE_PATH = "src/main/java/com/example/invoice/InvoiceController.java";

    private final FindingRepository findings;

    public DemoFindingBindingController(FindingRepository findings) {
        this.findings = findings;
    }

    public record BindingRequest(
            @Min(1) long expectedRevision,
            @NotBlank @Size(max = 120) String repositoryId,
            @NotBlank @Size(max = 500) String repositoryUrl,
            @NotBlank @Pattern(regexp = "[0-9a-f]{40}") String baseCommit,
            @NotBlank @Size(max = 500) String sourcePath,
            @NotBlank @Size(max = 24) @Pattern(regexp = "[0-9]+(?:-[0-9]+)?") String lineRange,
            @NotBlank @Size(max = 500) String findingName) {}

    @PostMapping("/{id}/bind-demo-repository")
    @Transactional
    public Finding bind(@PathVariable String id, @Valid @RequestBody BindingRequest request,
                        HttpServletRequest httpRequest) {
        if (!isLoopback(httpRequest.getRemoteAddr())) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Loopback access required");
        }
        if (!FINDING_ID.equals(id)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Only the designated demo Finding can be rebound");
        }

        Finding finding = findings.findById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Finding not found"));
        if (!validNewTarget(request)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid demo repository binding target");
        }
        if (alreadyBound(finding, request)) return finding;

        requireConflict(finding.revision == request.expectedRevision(), "Finding revision changed");
        requireConflict(isOriginalUnclaimedFinding(finding), "Finding is not the expected unclaimed placeholder");

        finding.repositoryId = request.repositoryId();
        finding.repositoryUrl = request.repositoryUrl();
        finding.baseCommit = request.baseCommit();
        finding.sourcePath = request.sourcePath();
        finding.lineRange = request.lineRange();
        finding.name = request.findingName();
        return findings.saveAndFlush(finding);
    }

    private static boolean validNewTarget(BindingRequest request) {
        return NEW_REPOSITORY_ID.equals(request.repositoryId())
                && NEW_REPOSITORY_URL.equals(request.repositoryUrl())
                && NEW_SOURCE_PATH.equals(request.sourcePath())
                && INVOICE_FINDING_NAME.equals(request.findingName());
    }

    private static boolean alreadyBound(Finding finding, BindingRequest request) {
        return NEW_REPOSITORY_ID.equals(finding.repositoryId)
                && NEW_REPOSITORY_URL.equals(finding.repositoryUrl)
                && request.baseCommit().equals(finding.baseCommit)
                && NEW_SOURCE_PATH.equals(finding.sourcePath)
                && request.lineRange().equals(finding.lineRange)
                && INVOICE_FINDING_NAME.equals(finding.name);
    }

    private static boolean isOriginalUnclaimedFinding(Finding finding) {
        return OWNER_ID.equals(finding.ownerId)
                && PLACEHOLDER_NAME.equals(finding.name)
                && OLD_REPOSITORY_ID.equals(finding.repositoryId)
                && OLD_REPOSITORY_URL.equals(finding.repositoryUrl)
                && OLD_BASE_COMMIT.equals(finding.baseCommit)
                && finding.sourcePath == null
                && finding.lineRange == null
                && "Not Started".equals(finding.status)
                && "Open".equals(finding.closed)
                && finding.workItemId == null
                && finding.remediationJobId == null;
    }

    private static boolean isLoopback(String remoteAddress) {
        if (remoteAddress == null || remoteAddress.isBlank()) return false;
        try {
            return InetAddress.getByName(remoteAddress).isLoopbackAddress();
        } catch (Exception ignored) {
            return false;
        }
    }

    private static void requireConflict(boolean condition, String message) {
        if (!condition) throw new ResponseStatusException(HttpStatus.CONFLICT, message);
    }
}
