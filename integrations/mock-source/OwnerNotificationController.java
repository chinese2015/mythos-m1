package com.example.argondemo.api;

import com.example.argondemo.domain.Finding;
import com.example.argondemo.domain.FindingRepository;
import com.example.argondemo.service.MailDelivery;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;

/** Operator demo adapter: creates preview artifacts, never sends real mail. */
@RestController
@RequestMapping("/api/findings")
public class OwnerNotificationController {
    private final FindingRepository findings;
    private final MailDelivery mail;
    private final ObjectMapper mapper;
    private final Path outbox;
    public OwnerNotificationController(FindingRepository findings, MailDelivery mail, ObjectMapper mapper,
        @Value("${notification.outbox-dir:./data/outbox}") String outbox) {
        this.findings = findings; this.mail = mail; this.mapper = mapper; this.outbox = Path.of(outbox);
    }
    public record NotificationRequest(@Pattern(regexp="intake-[a-f0-9]{64}") @NotBlank String notificationId,
        @Min(1) long expectedRevision, @NotBlank @Pattern(regexp="[A-Za-z0-9_-]{1,120}") String ownerId) {}

    @PostMapping("/{id}/notify-owner")
    public Map<String,Object> notifyOwner(@PathVariable String id, @Valid @RequestBody NotificationRequest req, HttpServletRequest request) throws Exception {
        if (!Set.of("127.0.0.1", "::1", "0:0:0:0:0:0:0:1").contains(request.getRemoteAddr()))
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Only the local operator may request previews");
        if (!mail.isPreview()) throw new ResponseStatusException(HttpStatus.CONFLICT, "Owner notifications require preview mode");
        Finding f = findings.findById(id).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Finding not found"));
        boolean eligible = "Not Started".equals(f.status) && !"Closed".equals(f.closed) && f.workItemId == null
            && "CONFIRMED".equals(f.triageResult) && Set.of("HIGH", "CRITICAL").contains(f.risk)
            && req.ownerId().equals(f.ownerId) && f.revision == req.expectedRevision();
        if (!eligible) throw new ResponseStatusException(HttpStatus.CONFLICT, "Finding changed or is not eligible");
        byte[] binding = mapper.writeValueAsBytes(List.of(f.id, f.ownerId, f.repositoryUrl, f.baseCommit, f.sourcePath));
        String expected = "intake-" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(binding));
        if (!expected.equals(req.notificationId())) throw new ResponseStatusException(HttpStatus.CONFLICT, "Notification binding changed");
        String to = f.ownerId + "@argon.demo";
        String subject = ("[Argon] 批准请求：" + id + " " + f.name).replace('\r', ' ').replace('\n', ' ');
        String body = "To: " + to + "\r\nFrom: argon-demo@example.test\r\nSubject: " + subject
            + "\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nX-Argon-Intake: " + req.notificationId()
            + "\n来源：" + id + "\n风险：" + f.risk + "\n类别：" + f.category + "\nOwner 团队：" + f.ownerTeamsId
            + "\n研判：" + f.triageResult + "\n请在任务中心批准接管，批准前不会启动修复。\nhttp://127.0.0.1:3080/argon/\n";
        Files.createDirectories(outbox);
        Path receipt = outbox.resolve(id + "-" + req.notificationId() + ".eml");
        Path temporary = Files.createTempFile(outbox, ".intake-", ".tmp");
        try {
            Files.writeString(temporary, body, StandardCharsets.UTF_8);
            try { Files.createLink(receipt, temporary); }
            catch (FileAlreadyExistsException ignored) {
                if (!Files.readString(receipt).equals(body)) throw new ResponseStatusException(HttpStatus.CONFLICT, "Preview receipt changed");
            }
        } finally { Files.deleteIfExists(temporary); }
        return Map.of("delivered", true, "preview", true, "to", to, "notificationId", req.notificationId());
    }
}
