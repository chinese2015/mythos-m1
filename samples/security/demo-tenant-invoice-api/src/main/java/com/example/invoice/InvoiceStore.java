package com.example.invoice;

import java.math.BigDecimal;
import java.util.Map;

public final class InvoiceStore {
    public record Invoice(String id, String tenantId, String customerLabel, BigDecimal total) {}

    private final Map<String, Invoice> invoices = Map.of(
            "inv-a-1001", new Invoice("inv-a-1001", "tenant-A", "Demo Customer A", new BigDecimal("12.50")),
            "inv-b-2001", new Invoice("inv-b-2001", "tenant-B", "Demo Customer B", new BigDecimal("54.00"))
    );

    public Invoice find(String id) {
        return invoices.get(id);
    }
}
