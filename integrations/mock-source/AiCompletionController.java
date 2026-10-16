package com.example.argondemo.api;

import com.example.argondemo.domain.Finding;
import com.example.argondemo.domain.FindingRepository;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import org.springframework.http.HttpStatus;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.net.URI;

@RestController
@RequestMapping("/api/findings")
public class AiCompletionController {
    private final FindingRepository findings;

    public AiCompletionController(FindingRepository findings) { this.findings = findings; }

    public record CompletionRequest(
        @Min(0) long expectedRevision,
        @NotBlank @Size(max=120) String workItemId,
        @NotBlank @Size(max=120) String ownerId,
        @NotBlank @Size(max=500) String repositoryUrl,
        @NotBlank @Pattern(regexp="[0-9a-fA-F]{40}") String baseCommit,
        @NotBlank @Size(max=500) String sourcePath,
        @NotBlank @Pattern(regexp="[0-9a-fA-F]{40}") String codeFixCommit,
        @NotBlank @Size(max=500) String prUrl) {}

    @PostMapping("/{id}/ai-completion")
    @Transactional
    public Finding complete(@PathVariable String id, @Valid @RequestBody CompletionRequest req) {
        Finding f = findings.findById(id).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Finding not found"));

        requireConflict(f.ownerId != null && f.ownerId.equals(req.ownerId()), "owner binding changed");
        requireConflict(f.workItemId != null && f.workItemId.equals(req.workItemId()), "work item binding changed");
        requireConflict(req.workItemId().equals(f.remediationJobId), "remediation job binding changed");
        requireConflict(f.repositoryUrl != null && f.repositoryUrl.equals(req.repositoryUrl()), "repository binding changed");
        requireConflict(f.baseCommit != null && f.baseCommit.equalsIgnoreCase(req.baseCommit()), "baseline commit changed");
        requireConflict(f.sourcePath != null && f.sourcePath.equals(req.sourcePath()), "source path changed");
        requireConflict(isRepositoryPullRequest(req.repositoryUrl(), req.prUrl()), "PR link does not identify the bound local repository");

        boolean exactReplay = "Resolved".equals(f.status) && "Closed".equals(f.closed)
            && "PASSED".equals(f.verificationResult)
            && req.codeFixCommit().equalsIgnoreCase(f.codeFixCommit)
            && req.prUrl().equals(f.prUrl);
        if (exactReplay) return f;

        requireConflict("In Progress".equals(f.status), "finding is no longer In Progress");
        requireConflict(f.revision == req.expectedRevision(), "finding revision changed");

        f.verificationResult = "PASSED";
        f.codeFixCommit = req.codeFixCommit().toLowerCase();
        f.prUrl = req.prUrl();
        f.status = "Resolved";
        f.closed = "Closed";
        return findings.saveAndFlush(f);
    }

    private static void requireConflict(boolean condition, String message) {
        if (!condition) throw new ResponseStatusException(HttpStatus.CONFLICT, message);
    }

    private static boolean isRepositoryPullRequest(String repositoryUrl, String prUrl) {
        try {
            URI repo = URI.create(repositoryUrl);
            URI pr = URI.create(prUrl);
            if (!"http".equalsIgnoreCase(repo.getScheme()) || !"http".equalsIgnoreCase(pr.getScheme())
                || !"127.0.0.1".equals(repo.getHost()) || !"127.0.0.1".equals(pr.getHost())
                || repo.getPort() != 3000 || pr.getPort() != 3000
                || repo.getUserInfo() != null || pr.getUserInfo() != null
                || repo.getQuery() != null || repo.getFragment() != null || pr.getQuery() != null || pr.getFragment() != null) return false;
            String[] repositoryParts = repo.getPath().split("/");
            String[] prParts = pr.getPath().split("/");
            if (repositoryParts.length != 3 || !"".equals(repositoryParts[0]) || !"demo".equals(repositoryParts[1])
                || !repositoryParts[2].endsWith(".git")) return false;
            String repositoryName = repositoryParts[2].substring(0, repositoryParts[2].length() - 4);
            if (!java.util.Set.of("demo-nova-catalog-api", "demo-orion-notes-api", "demo-pixel-reports-batch").contains(repositoryName)) return false;
            return prParts.length == 5 && "".equals(prParts[0]) && "demo".equals(prParts[1])
                && repositoryName.equals(prParts[2]) && "pulls".equals(prParts[3])
                && prParts[4].matches("[1-9][0-9]{0,8}");
        } catch (IllegalArgumentException e) {
            return false;
        }
    }
}
