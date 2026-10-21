package com.example.mythosdemo.api;

import com.example.mythosdemo.domain.Finding;
import com.example.mythosdemo.domain.FindingRepository;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

/**
 * Demo bridge: a finding page action pushes the current finding into the local
 * Mythos task workspace through its push intake endpoint. Server-to-server so
 * the browser stays same-origin and the intake host fence sees loopback.
 */
@RestController
@RequestMapping("/api")
public class PushTaskController {
    private final FindingRepository findings;
    private final String intakeUrl;
    private final HttpClient http = HttpClient.newBuilder()
            .version(HttpClient.Version.HTTP_1_1)
            .connectTimeout(Duration.ofSeconds(5))
            .build();

    public PushTaskController(FindingRepository findings,
            @Value("${mythos.task-intake-url:http://127.0.0.1:13080/mythos/api/source-findings}") String intakeUrl) {
        this.findings = findings;
        this.intakeUrl = intakeUrl;
    }

    @PostMapping("/findings/{id}/push-task")
    public ResponseEntity<String> push(@PathVariable String id) {
        Finding f = findings.findById(id).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Finding not found"));
        HttpRequest request = HttpRequest.newBuilder(URI.create(intakeUrl))
                .timeout(Duration.ofSeconds(30))
                .header("Content-Type", "application/json")
                .header("x-mythos-action", "1")
                .header("Idempotency-Key", "mock-push-" + f.id)
                .POST(HttpRequest.BodyPublishers.ofString("{\"findingId\":\"" + f.id + "\"}"))
                .build();
        final HttpResponse<String> response;
        try {
            response = http.send(request, HttpResponse.BodyHandlers.ofString());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "Task intake interrupted");
        } catch (IOException e) {
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "Task workspace is unreachable: " + e.getMessage());
        }
        return ResponseEntity.status(response.statusCode()).contentType(MediaType.APPLICATION_JSON).body(response.body());
    }
}
