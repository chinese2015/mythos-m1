package com.example.argondemo;

import com.example.argondemo.domain.Finding;
import com.example.argondemo.domain.FindingRepository;
import com.example.argondemo.service.MailDelivery;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.TestPropertySource;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.util.ReflectionTestUtils;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@SpringBootTest
@AutoConfigureMockMvc
@TestPropertySource(properties={"spring.datasource.url=jdbc:h2:mem:argon-owner-notification;DB_CLOSE_DELAY=-1", "spring.jpa.hibernate.ddl-auto=create-drop", "notification.mode=preview", "notification.outbox-dir=./target/owner-notification-outbox"})
class OwnerNotificationIntegrationTests {
    @Autowired MockMvc mvc;
    @Autowired FindingRepository findings;
    @Autowired ObjectMapper mapper;
    @Autowired MailDelivery mail;
    private Finding finding;
    private final Path outbox = Path.of("target/owner-notification-outbox");
    @BeforeEach void reset() throws Exception {
        ReflectionTestUtils.setField(mail, "mode", "preview");
        if (Files.exists(outbox)) try (var files = Files.list(outbox)) { for (Path p : files.toList()) Files.delete(p); }
        Finding f = findings.findById("FND-00015").orElseThrow();
        f.ownerId = "owner-pixel-01"; f.ownerTeamsId = "pixel-team"; f.risk = "HIGH";
        f.status = "Not Started"; f.closed = "Open"; f.workItemId = null; f.triageResult = "CONFIRMED";
        finding = findings.saveAndFlush(f);
    }
    private String body() throws Exception {
        byte[] binding = mapper.writeValueAsBytes(List.of(finding.id, finding.ownerId, finding.repositoryUrl, finding.baseCommit, finding.sourcePath));
        String id = "intake-" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(binding));
        return mapper.writeValueAsString(Map.of("notificationId", id, "expectedRevision", finding.revision, "ownerId", finding.ownerId));
    }
    @Test void localPreviewIsIdempotentAndDoesNotClaimFinding() throws Exception {
        String request = body();
        for (int n=0; n<2; n++) mvc.perform(post("/api/findings/FND-00015/notify-owner").contentType(MediaType.APPLICATION_JSON).content(request))
            .andExpect(status().isOk()).andExpect(jsonPath("$.delivered").value(true)).andExpect(jsonPath("$.preview").value(true));
        try (var files = Files.list(outbox)) {
            var paths = files.toList(); assertEquals(1, paths.size());
            String eml = Files.readString(paths.get(0));
            assertTrue(eml.contains("owner-pixel-01@argon.demo")); assertTrue(eml.contains("FND-00015"));
            assertTrue(eml.contains("http://127.0.0.1:3080/argon/")); assertTrue(eml.contains("CONFIRMED"));
        }
        Finding current = findings.findById(finding.id).orElseThrow();
        assertEquals("Not Started", current.status); assertNull(current.workItemId); assertEquals(finding.revision, current.revision);
    }
    @Test void rejectsRemoteStaleUnknownAndRealMailModes() throws Exception {
        String request = body();
        mvc.perform(post("/api/findings/FND-00015/notify-owner").with(r -> { r.setRemoteAddr("203.0.113.1"); return r; }).contentType(MediaType.APPLICATION_JSON).content(request)).andExpect(status().isForbidden());
        mvc.perform(post("/api/findings/FND-99999/notify-owner").contentType(MediaType.APPLICATION_JSON).content(request)).andExpect(status().isNotFound());
        finding.triageResult = "NEEDS_REVIEW"; findings.saveAndFlush(finding);
        mvc.perform(post("/api/findings/FND-00015/notify-owner").contentType(MediaType.APPLICATION_JSON).content(request)).andExpect(status().isConflict());
        ReflectionTestUtils.setField(mail, "mode", "smtp");
        mvc.perform(post("/api/findings/FND-00015/notify-owner").contentType(MediaType.APPLICATION_JSON).content(request)).andExpect(status().isConflict());
        assertFalse(Files.exists(outbox) && Files.list(outbox).findAny().isPresent());
    }
    @Test void retriesRecoverTheFirstReceiptAfterMutableMetadataChanges() throws Exception {
        mvc.perform(post("/api/findings/FND-00015/notify-owner").contentType(MediaType.APPLICATION_JSON).content(body())).andExpect(status().isOk());
        finding.name = "Updated finding title"; finding.ownerTeamsId = "renamed-team";
        finding = findings.saveAndFlush(finding);
        mvc.perform(post("/api/findings/FND-00015/notify-owner").contentType(MediaType.APPLICATION_JSON).content(body())).andExpect(status().isOk());
        try (var files = Files.list(outbox)) { assertEquals(1, files.count()); }
    }
}
