package com.example.mythosdemo.api;

import com.example.mythosdemo.domain.Finding;
import com.example.mythosdemo.domain.FindingRepository;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Min;
import org.springframework.http.HttpStatus;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.util.Map;
import java.util.Set;

@RestController
@RequestMapping("/api/findings")
public class ResetFindingController {
    private static final Set<String> RESETTABLE_IDS = Set.of("FND-00003", "FND-00009", "FND-00015");
    private final FindingRepository findings;

    public ResetFindingController(FindingRepository findings) { this.findings = findings; }

    public record ResetRequest(@Min(1) long expectedRevision) {}

    @GetMapping("/{id}/reset-demo")
    public Map<String, Object> capability(@PathVariable String id) {
        Finding finding = resettable(id);
        return Map.of("supported", true, "revision", finding.revision);
    }

    @PostMapping("/{id}/reset-demo")
    @Transactional
    public Finding reset(@PathVariable String id, @Valid @RequestBody ResetRequest request) {
        Finding finding = resettable(id);
        if (finding.revision != request.expectedRevision()) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Finding revision changed");
        }
        finding.status = "Not Started";
        finding.closed = "Open";
        finding.workItemId = "";
        finding.remediationJobId = "";
        finding.triageResult = "UNTRIAGED";
        finding.verificationResult = "NOT_RUN";
        finding.codeFixCommit = "";
        finding.prUrl = "";
        return findings.saveAndFlush(finding);
    }

    private Finding resettable(String id) {
        if (!RESETTABLE_IDS.contains(id)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Finding not found");
        }
        return findings.findById(id)
            .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Finding not found"));
    }
}
