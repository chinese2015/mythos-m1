package com.example.invoice;

import com.example.invoice.DemoPrincipalResolver.Principal;
import com.example.invoice.InvoiceStore.Invoice;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;

import java.io.IOException;
import java.nio.charset.StandardCharsets;

public final class InvoiceController implements HttpHandler {
    private final DemoPrincipalResolver principals;
    private final InvoiceStore invoices;

    public InvoiceController(DemoPrincipalResolver principals, InvoiceStore invoices) {
        this.principals = principals;
        this.invoices = invoices;
    }

    @Override
    public void handle(HttpExchange exchange) throws IOException {
        if (!"GET".equals(exchange.getRequestMethod())) {
            respond(exchange, 405, "{\"error\":\"method not allowed\"}");
            return;
        }

        String prefix = "/api/invoices/";
        String path = exchange.getRequestURI().getPath();
        if (!path.startsWith(prefix) || path.length() == prefix.length()) {
            respond(exchange, 404, "{\"error\":\"not found\"}");
            return;
        }
        String invoiceId = path.substring(prefix.length());
        if (invoiceId.contains("/")) {
            respond(exchange, 404, "{\"error\":\"not found\"}");
            return;
        }

        Principal principal = principals.resolve(exchange.getRequestHeaders().getFirst("Authorization"));
        if (principal == null) {
            respond(exchange, 401, "{\"error\":\"unauthorized\"}");
            return;
        }

        Invoice invoice = invoices.find(invoiceId);
        if (invoice == null) {
            respond(exchange, 404, "{\"error\":\"not found\"}");
            return;
        }

        // The training baseline authenticates the caller but omits object-level tenant authorization.
        String body = "{\"id\":\"" + invoice.id() + "\",\"tenantId\":\"" + invoice.tenantId()
                + "\",\"customer\":\"" + invoice.customerLabel() + "\",\"total\":" + invoice.total().toPlainString() + "}";
        respond(exchange, 200, body);
    }

    private static void respond(HttpExchange exchange, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        exchange.sendResponseHeaders(status, bytes.length);
        try (var output = exchange.getResponseBody()) {
            output.write(bytes);
        }
    }
}
