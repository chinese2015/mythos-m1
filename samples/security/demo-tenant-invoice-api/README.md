# Tenant invoice API training fixture

This local-only Java 17 project uses synthetic tenants, users, invoice IDs, and totals. It demonstrates a Broken Object Level Authorization (BOLA) defect in `GET /api/invoices/{invoiceId}`. The intentionally vulnerable baseline authenticates the request but does not enforce invoice ownership.

Argon's workspace preparation creates the ignored `.cache/settings.xml` settings file in the task sandbox. The frozen baseline command is:

```sh
mvn -B -o -s .cache/settings.xml test
```

The base commit is expected to report exactly two tests with one failure: `crossTenantInvoiceReadIsHidden`. The same-tenant, administrator, anonymous, and missing-invoice cases remain covered by the other test method. No network service, real account, or real invoice data is used.

For a raw local checkout, run `mvn -B -o test`; the parent repository's `tests/test_bola_demo_fixture.py` runs the frozen command in a temporary copy with local Maven settings and checks the exact baseline report.

Start the synthetic loopback server with:

```sh
mvn -B -o package
java -cp target/classes com.example.invoice.InvoiceServer
```

The sample credentials (`demo-tenant-a`, `demo-tenant-b`, `demo-admin`) are test identities only. Do not reuse them outside this fixture.
