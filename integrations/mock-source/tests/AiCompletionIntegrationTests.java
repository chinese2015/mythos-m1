package com.example.mythosdemo;

import com.example.mythosdemo.domain.Finding;
import com.example.mythosdemo.domain.FindingRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.orm.ObjectOptimisticLockingFailureException;
import org.springframework.test.context.TestPropertySource;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

import java.util.Map;

import static org.hamcrest.Matchers.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest
@AutoConfigureMockMvc
@TestPropertySource(properties={
    "spring.datasource.url=jdbc:h2:mem:mythos-mock-cas;DB_CLOSE_DELAY=-1",
    "spring.jpa.hibernate.ddl-auto=create-drop",
    "notification.mode=preview",
    "notification.outbox-dir=./target/mock-cas-outbox"
})
class AiCompletionIntegrationTests {
    private static final String ID = "FND-00003";
    private static final String COMMIT = "0123456789abcdef0123456789abcdef01234567";
    private static final String REPOSITORY = "http://127.0.0.1:3000/demo/demo-orion-notes-api.git";
    private static final String PR = "http://127.0.0.1:3000/demo/demo-orion-notes-api/pulls/17";
    @Autowired MockMvc mvc;
    @Autowired FindingRepository findings;
    @Autowired ObjectMapper mapper;

    @BeforeEach void bindMockWorkItem() {
        Finding f = findings.findById(ID).orElseThrow();
        f.ownerId = "owner-orion-01";
        f.repositoryUrl = REPOSITORY;
        f.baseCommit = "2ce309f4dd7a39a22fcce59ad4309a50e1df237e";
        f.sourcePath = "src/main/java/com/example/notes/AppConfig.java";
        f.workItemId = "work-123";
        f.remediationJobId = "work-123";
        f.status = "In Progress";
        f.closed = "Open";
        f.verificationResult = "NOT_RUN";
        f.codeFixCommit = null;
        f.prUrl = null;
        findings.saveAndFlush(f);
    }

    private String body(long revision) throws Exception {
        return mapper.writeValueAsString(Map.of(
            "expectedRevision", revision,
            "workItemId", "work-123",
            "ownerId", "owner-orion-01",
            "repositoryUrl", REPOSITORY,
            "baseCommit", "2ce309f4dd7a39a22fcce59ad4309a50e1df237e",
            "sourcePath", "src/main/java/com/example/notes/AppConfig.java",
            "codeFixCommit", COMMIT,
            "prUrl", PR));
    }

    @Test void completionAtomicallyPassesVerificationAndClosesFinding() throws Exception {
        Finding before = findings.findById(ID).orElseThrow();
        mvc.perform(post("/api/findings/{id}/ai-completion", ID).contentType(MediaType.APPLICATION_JSON).content(body(before.revision)))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.verificationResult").value("PASSED"))
            .andExpect(jsonPath("$.codeFixCommit").value(COMMIT))
            .andExpect(jsonPath("$.prUrl").value(PR))
            .andExpect(jsonPath("$.status").value("Resolved"))
            .andExpect(jsonPath("$.closed").value("Closed"));
        mvc.perform(patch("/api/findings/{id}", ID).contentType(MediaType.APPLICATION_JSON)
                .content("{\"status\":\"Resolved\",\"verificationResult\":\"PASSED\"}"))
            .andExpect(status().isOk());
    }

    @Test void rejectsWrongOwnerSourceAndWorkBindingWithConflict() throws Exception {
        Finding before = findings.findById(ID).orElseThrow();
        for (Map.Entry<String, String> change : Map.of(
                "ownerId", "other-owner", "sourcePath", "src/other.java", "workItemId", "other-work").entrySet()) {
            Map<String, Object> request = mapper.readValue(body(before.revision), Map.class);
            request.put(change.getKey(), change.getValue());
            String changed = mapper.writeValueAsString(request);
            mvc.perform(post("/api/findings/{id}/ai-completion", ID).contentType(MediaType.APPLICATION_JSON).content(changed))
                .andExpect(status().isConflict());
        }
    }

    @Test void staleRevisionIsConflictAndLeavesFindingOpen() throws Exception {
        Finding before = findings.findById(ID).orElseThrow();
        before.comment = "edited while delivery was open";
        findings.saveAndFlush(before);
        mvc.perform(post("/api/findings/{id}/ai-completion", ID).contentType(MediaType.APPLICATION_JSON).content(body(before.revision - 1)))
            .andExpect(status().isConflict());
        Finding after = findings.findById(ID).orElseThrow();
        assertEquals("In Progress", after.status);
        assertEquals("NOT_RUN", after.verificationResult);
        assertNull(after.codeFixCommit);
    }

    @Test void rejectsFindingWhoseRemediationJobIsNotBoundToWorkItem() throws Exception {
        Finding before = findings.findById(ID).orElseThrow();
        before.remediationJobId = "different-job";
        findings.saveAndFlush(before);
        mvc.perform(post("/api/findings/{id}/ai-completion", ID).contentType(MediaType.APPLICATION_JSON).content(body(before.revision)))
            .andExpect(status().isConflict());
    }

    @Test void rejectsPrHostOutsideTheSyntheticLocalGitea() throws Exception {
        Finding before = findings.findById(ID).orElseThrow();
        String changed = body(before.revision).replace(PR,
            "http://127.0.0.1:3001/demo/demo-orion-notes-api/pulls/17");
        mvc.perform(post("/api/findings/{id}/ai-completion", ID).contentType(MediaType.APPLICATION_JSON).content(changed))
            .andExpect(status().isConflict());
    }

    @Test void acceptsTheExactLocalGiteaOriginAndAllowlistedRepositoryPath() throws Exception {
        Finding before = findings.findById(ID).orElseThrow();
        mvc.perform(post("/api/findings/{id}/ai-completion", ID).contentType(MediaType.APPLICATION_JSON).content(body(before.revision)))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.repositoryUrl").value(REPOSITORY))
            .andExpect(jsonPath("$.prUrl").value(PR));
    }

    @Test void rejectsNonLocalOriginsAndUnallowlistedRepositoryPathsEvenWhenStoredOnFinding() throws Exception {
        for (String[] candidate : new String[][]{
                {"https://127.0.0.1:3000/demo/demo-orion-notes-api.git", "https://127.0.0.1:3000/demo/demo-orion-notes-api/pulls/17"},
                {"http://localhost:3000/demo/demo-orion-notes-api.git", "http://localhost:3000/demo/demo-orion-notes-api/pulls/17"},
                {"http://127.0.0.1:3001/demo/demo-orion-notes-api.git", "http://127.0.0.1:3001/demo/demo-orion-notes-api/pulls/17"},
                {"http://user@127.0.0.1:3000/demo/demo-orion-notes-api.git", "http://user@127.0.0.1:3000/demo/demo-orion-notes-api/pulls/17"},
                {"http://127.0.0.1:3000/demo/demo-orion-notes-api.git?x=1", "http://127.0.0.1:3000/demo/demo-orion-notes-api/pulls/17"},
                {"http://127.0.0.1:3000/demo/demo-orion-notes-api.git#x", "http://127.0.0.1:3000/demo/demo-orion-notes-api/pulls/17"},
                {"http://127.0.0.1:3000/demo/demo-orion-notes-api.git", "http://127.0.0.1:3000/demo/demo-orion-notes-api/pulls/17?x=1"},
                {"http://127.0.0.1:3000/demo/demo-orion-notes-api.git", "http://127.0.0.1:3000/demo/demo-orion-notes-api/pulls/17#x"},
                {"http://127.0.0.1:3000/demo/demo-aster-ui-service.git", "http://127.0.0.1:3000/demo/demo-aster-ui-service/pulls/17"}
        }) {
            Finding finding = findings.findById(ID).orElseThrow();
            finding.repositoryUrl = candidate[0];
            finding = findings.saveAndFlush(finding);
            String request = body(finding.revision).replace(REPOSITORY, candidate[0]).replace(PR, candidate[1]);
            mvc.perform(post("/api/findings/{id}/ai-completion", ID).contentType(MediaType.APPLICATION_JSON).content(request))
                .andExpect(status().isConflict());
        }
    }

    @Test void acceptsEveryAllowlistedLocalGiteaRepository() throws Exception {
        for (String repository : new String[]{"demo-nova-catalog-api", "demo-orion-notes-api", "demo-pixel-reports-batch"}) {
            String repositoryUrl = "http://127.0.0.1:3000/demo/" + repository + ".git";
            String prUrl = "http://127.0.0.1:3000/demo/" + repository + "/pulls/17";
            Finding finding = findings.findById(ID).orElseThrow();
            finding.repositoryUrl = repositoryUrl;
            finding.status = "In Progress";
            finding.closed = "Open";
            finding.verificationResult = "NOT_RUN";
            finding.codeFixCommit = null;
            finding.prUrl = null;
            finding = findings.saveAndFlush(finding);
            String request = body(finding.revision).replace(REPOSITORY, repositoryUrl).replace(PR, prUrl);
            mvc.perform(post("/api/findings/{id}/ai-completion", ID).contentType(MediaType.APPLICATION_JSON).content(request))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.repositoryUrl").value(repositoryUrl))
                .andExpect(jsonPath("$.prUrl").value(prUrl));
        }
    }

    @Test void exactLostAcknowledgementReplaySucceedsWithOldRevision() throws Exception {
        Finding before = findings.findById(ID).orElseThrow();
        String request = body(before.revision);
        mvc.perform(post("/api/findings/{id}/ai-completion", ID).contentType(MediaType.APPLICATION_JSON).content(request)).andExpect(status().isOk());
        mvc.perform(post("/api/findings/{id}/ai-completion", ID).contentType(MediaType.APPLICATION_JSON).content(request))
            .andExpect(status().isOk()).andExpect(jsonPath("$.revision").value(before.revision + 1));
        assertEquals(before.revision + 1, findings.findById(ID).orElseThrow().revision);
    }

    @Test void legacyPatchAdvancesVersionAndStaleWriterCannotOverwrite() throws Exception {
        Finding before = findings.findById(ID).orElseThrow();
        mvc.perform(patch("/api/findings/{id}", ID).contentType(MediaType.APPLICATION_JSON).content("{\"comment\":\"first\"}"))
            .andExpect(status().isOk());
        mvc.perform(patch("/api/findings/{id}", ID).contentType(MediaType.APPLICATION_JSON).content("{\"comment\":\"second\"}"))
            .andExpect(status().isOk());
        Finding after = findings.findById(ID).orElseThrow();
        assertEquals("second", after.comment);
        assertTrue(after.revision >= before.revision + 2);
        before.comment = "stale concurrent writer";
        assertThrows(ObjectOptimisticLockingFailureException.class, () -> findings.saveAndFlush(before));
        assertEquals("second", findings.findById(ID).orElseThrow().comment);
    }
}
