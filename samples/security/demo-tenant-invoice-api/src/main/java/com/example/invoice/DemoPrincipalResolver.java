package com.example.invoice;

import java.util.Map;

public final class DemoPrincipalResolver {
    public enum Role { TENANT, ADMIN }

    public record Principal(String subject, String tenantId, Role role) {
        public boolean administrator() {
            return role == Role.ADMIN;
        }
    }

    private static final Map<String, Principal> DEMO_IDENTITIES = Map.of(
            "Bearer demo-tenant-a", new Principal("user-a-01", "tenant-A", Role.TENANT),
            "Bearer demo-tenant-b", new Principal("user-b-01", "tenant-B", Role.TENANT),
            "Bearer demo-admin", new Principal("support-01", "tenant-support", Role.ADMIN)
    );

    public Principal resolve(String authorizationHeader) {
        if (authorizationHeader == null) return null;
        return DEMO_IDENTITIES.get(authorizationHeader);
    }
}
