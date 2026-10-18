package com.example.invoice;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;

class InvoiceControllerTest {
    private final HttpClient client = HttpClient.newHttpClient();
    private HttpServer server;
    private String origin;

    @BeforeEach
    void startServer() throws IOException {
        server = InvoiceServer.createServer(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0));
        server.start();
        origin = "http://127.0.0.1:" + server.getAddress().getPort();
    }

    @AfterEach
    void stopServer() {
        if (server != null) server.stop(0);
    }

    @Test
    void crossTenantInvoiceReadIsHidden() throws Exception {
        HttpResponse<String> response = get(
                "/api/invoices/inv-b-2001?tenantId=tenant-B",
                "Bearer demo-tenant-a",
                "tenant-B"
        );

        assertEquals(404, response.statusCode(), response.body());
    }

    @Test
    void sameTenantAdminAndAnonymousAccessRemainCorrect() throws Exception {
        assertDoesNotThrow(() -> new DemoPrincipalResolver().resolve(null));

        HttpResponse<String> sameTenant = get("/api/invoices/inv-a-1001", "Bearer demo-tenant-a", null);
        HttpResponse<String> administrator = get("/api/invoices/inv-b-2001", "Bearer demo-admin", null);
        HttpResponse<String> anonymous = get("/api/invoices/inv-a-1001", null, null);
        HttpResponse<String> missing = get("/api/invoices/inv-does-not-exist", "Bearer demo-tenant-a", null);

        assertEquals(200, sameTenant.statusCode(), sameTenant.body());
        assertEquals(200, administrator.statusCode(), administrator.body());
        assertEquals(401, anonymous.statusCode(), anonymous.body());
        assertEquals(404, missing.statusCode(), missing.body());
    }

    private HttpResponse<String> get(String path, String authorization, String tenantHeader) throws Exception {
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(origin + path)).GET();
        if (authorization != null) builder.header("Authorization", authorization);
        if (tenantHeader != null) builder.header("X-Tenant-Id", tenantHeader);
        return client.send(builder.build(), HttpResponse.BodyHandlers.ofString());
    }
}
