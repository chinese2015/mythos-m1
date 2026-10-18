package com.example.argondemo;

import com.example.argondemo.domain.Finding;
import com.example.argondemo.domain.FindingRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;

import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest
@AutoConfigureMockMvc
@TestPropertySource(properties = {
        "spring.datasource.url=jdbc:h2:mem:argon-bola-binding;DB_CLOSE_DELAY=-1",
        "spring.jpa.hibernate.ddl-auto=create-drop",
        "spring.jpa.show-sql=false"
})
class DemoFindingBindingIntegrationTests {
    private static final String ID = "FND-00016";
    private static final String PLACEHOLDER_REPOSITORY_ID = "REPO-demo-aster-ui-service";
    private static final String PLACEHOLDER_URL = "https://git.example.test/demo/demo-aster-ui-service.git";
    private static final String PLACEHOLDER_COMMIT = "6a11c9d2e8f34b0a9d5e7c61f2b8a0d4e6c3f1a2";
    private static final String PLACEHOLDER_NAME = "Example multi-user notes view lacks mock tenant scope";
    private static final String INVOICE_FINDING_NAME = "Invoice endpoint exposes another tenant's invoice by ID";
    private static final String REPOSITORY_ID = "REPO-demo-tenant-invoice-api";
    private static final String REPOSITORY_URL = "http://127.0.0.1:3000/demo/demo-tenant-invoice-api.git";
    private static final String SOURCE_PATH = "src/main/java/com/example/invoice/InvoiceController.java";
    private static final String BASE_COMMIT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static final AtomicInteger FIXTURE_SEQUENCE = new AtomicInteger();

    @Autowired MockMvc mvc;
    @Autowired FindingRepository findings;
    @Autowired ObjectMapper mapper;

    @BeforeEach
    void resetUnclaimedFnd16Placeholder() {
        Finding finding = findings.findById(ID).orElseThrow();
        finding.ownerId = "owner-aster-01";
        finding.name = PLACEHOLDER_NAME;
        finding.repositoryId = PLACEHOLDER_REPOSITORY_ID;
        finding.repositoryUrl = PLACEHOLDER_URL;
        finding.baseCommit = PLACEHOLDER_COMMIT;
        finding.sourcePath = null;
        finding.lineRange = null;
        finding.status = "Not Started";
        finding.closed = "Open";
        finding.workItemId = null;
        finding.remediationJobId = null;
        finding.triageResult = "UNTRIAGED";
        finding.verificationResult = "NOT_RUN";
        finding.codeFixCommit = null;
        finding.prUrl = null;
        finding.comment = "BOLA binding test fixture " + FIXTURE_SEQUENCE.incrementAndGet();
        findings.saveAndFlush(finding);
    }

    @Test
    void bindsExactPlaceholderAndExactReplayDoesNotAdvanceRevision() throws Exception {
        Finding before = findings.findById(ID).orElseThrow();
        String owner = before.ownerId, category = before.category, risk = before.risk;
        double score = before.score;
        String status = before.status, closed = before.closed;
        String request = body(before.revision, REPOSITORY_ID, REPOSITORY_URL, BASE_COMMIT, SOURCE_PATH, "18-26");

        var first = mvc.perform(post("/api/findings/{id}/bind-demo-repository", ID)
                        .contentType(MediaType.APPLICATION_JSON).content(request))
                .andExpect(status().isOk()).andReturn();
        Finding bound = mapper.readValue(first.getResponse().getContentAsString(), Finding.class);
        assertEquals(REPOSITORY_ID, bound.repositoryId);
        assertEquals(REPOSITORY_URL, bound.repositoryUrl);
        assertEquals(BASE_COMMIT, bound.baseCommit);
        assertEquals(SOURCE_PATH, bound.sourcePath);
        assertEquals(INVOICE_FINDING_NAME, bound.name);
        assertEquals(owner, bound.ownerId);
        assertEquals(category, bound.category);
        assertEquals(risk, bound.risk);
        assertEquals(score, bound.score);
        assertEquals(status, bound.status);
        assertEquals(closed, bound.closed);
        assertEquals(before.revision + 1, bound.revision);

        var replay = mvc.perform(post("/api/findings/{id}/bind-demo-repository", ID)
                        .contentType(MediaType.APPLICATION_JSON).content(request))
                .andExpect(status().isOk()).andReturn();
        Finding replayed = mapper.readValue(replay.getResponse().getContentAsString(), Finding.class);
        assertEquals(INVOICE_FINDING_NAME, replayed.name);
        assertEquals(bound.revision, replayed.revision);
    }

    @Test
    void rejectsStaleRevisionAndChangedBinding() throws Exception {
        Finding before = findings.findById(ID).orElseThrow();
        assertTrue(before.revision > 1, "fixture reset must advance the optimistic-lock version");
        mvc.perform(post("/api/findings/{id}/bind-demo-repository", ID)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body(before.revision - 1, REPOSITORY_ID, REPOSITORY_URL, BASE_COMMIT, SOURCE_PATH, "18-26")))
                .andExpect(status().isConflict());

        mvc.perform(post("/api/findings/{id}/bind-demo-repository", ID)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body(before.revision, REPOSITORY_ID, "http://127.0.0.1:3001/demo/demo-tenant-invoice-api.git", BASE_COMMIT, SOURCE_PATH, "18-26")))
                .andExpect(status().isBadRequest());

        mvc.perform(post("/api/findings/{id}/bind-demo-repository", ID)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body(before.revision, REPOSITORY_ID, REPOSITORY_URL, BASE_COMMIT,
                                "src/main/java/com/example/invoice/OtherController.java", "18-26")))
                .andExpect(status().isBadRequest());
    }

    @Test
    void rejectsDifferentFindingOwnerOrClaimedRecord() throws Exception {
        Finding before = findings.findById(ID).orElseThrow();
        before.ownerId = "owner-other-01";
        findings.saveAndFlush(before);
        mvc.perform(post("/api/findings/{id}/bind-demo-repository", ID)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body(before.revision, REPOSITORY_ID, REPOSITORY_URL, BASE_COMMIT, SOURCE_PATH, "18-26")))
                .andExpect(status().isConflict());

        before = findings.findById(ID).orElseThrow();
        before.ownerId = "owner-aster-01";
        before.status = "In Progress";
        before.workItemId = "work-11111111111111111111111111111111";
        before.remediationJobId = before.workItemId;
        findings.saveAndFlush(before);
        mvc.perform(post("/api/findings/{id}/bind-demo-repository", ID)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body(before.revision, REPOSITORY_ID, REPOSITORY_URL, BASE_COMMIT, SOURCE_PATH, "18-26")))
                .andExpect(status().isConflict());

        mvc.perform(post("/api/findings/{id}/bind-demo-repository", "FND-00009")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body(before.revision, REPOSITORY_ID, REPOSITORY_URL, BASE_COMMIT, SOURCE_PATH, "18-26")))
                .andExpect(status().isConflict());
    }

    @Test
    void rejectsNonLoopbackCallers() throws Exception {
        Finding before = findings.findById(ID).orElseThrow();
        mvc.perform(post("/api/findings/{id}/bind-demo-repository", ID)
                        .with(request -> { request.setRemoteAddr("203.0.113.1"); return request; })
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body(before.revision, REPOSITORY_ID, REPOSITORY_URL, BASE_COMMIT, SOURCE_PATH, "18-26")))
                .andExpect(status().isForbidden());
    }

    private String body(long revision, String repositoryId, String repositoryUrl, String baseCommit,
                        String sourcePath, String lineRange) throws Exception {
        return mapper.writeValueAsString(Map.of("expectedRevision", revision, "repositoryId", repositoryId,
                "repositoryUrl", repositoryUrl, "baseCommit", baseCommit, "sourcePath", sourcePath,
                "lineRange", lineRange, "findingName", INVOICE_FINDING_NAME));
    }
}
