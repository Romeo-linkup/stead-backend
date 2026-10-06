# Permissions Matrix

Access per route and role. `owner`, `admin`, `property_manager`, `tenant`, `service_provider`.
A dash (—) means the role cannot call the route. Scoping: non-owner roles are limited
to their own district inside their organisation; the owner is limited to their
organisation's districts.

| Route | owner | admin | property_manager | tenant | service_provider |
|-------|-------|-------|------------------|--------|------------------|
| GET /districts | ✓ org districts | ✓ own district | ✓ own district | — | — |
| POST /districts | ✓ org | — | — | — | — |
| PATCH /districts/:id (rename) | ✓ org | — | — | — | — |
| DELETE /districts/:id | ✓ org | — | — | — | — |
| GET /codes | ✓ org | ✓ own district (tenant/service_provider only) | ✓ own district (tenant/service_provider only) | — | — |
| POST /codes | ✓ (admin/property_manager/service_provider/tenant) | ✓ (service_provider/tenant, own district) | ✓ (service_provider/tenant, own district) | — | — |
| PATCH /codes/:id/revoke | ✓ org | ✓ own district (tenant/service_provider) | ✓ own district (tenant/service_provider) | — | — |
| GET /properties | ✓ org | ✓ own district | ✓ own district | — | — |
| POST /properties | ✓ org | ✓ own district | ✓ own district | — | — |
| PATCH /properties/:id | ✓ org | ✓ own district | ✓ own district | — | — |
| DELETE /properties/:id | ✓ org | ✓ own district | ✓ own district | — | — |
| GET /units | ✓ org | ✓ own district | ✓ own district | — | — |
| POST /units | ✓ org | ✓ own district | ✓ own district | — | — |
| POST /units/bulk | ✓ org | ✓ own district | ✓ own district | — | — |
| GET /units/:id | ✓ org | ✓ own district | ✓ own district | ✓ own unit | — |
| GET /units/me | — | — | — | ✓ own unit | — |
| PATCH /units/:id | ✓ org | ✓ own district | ✓ own district | — | — |
| DELETE /units/:id | ✓ org | ✓ own district | ✓ own district | — | — |
| GET /leases | ✓ org | ✓ own district | ✓ own district | ✓ own unit | — |
| POST /leases | ✓ org | ✓ own district | ✓ own district | — | — |
| GET /leases/:id | ✓ org | ✓ own district | ✓ own district | ✓ own unit | — |
| PATCH /leases/:id | ✓ org | ✓ own district | ✓ own district | — | — |
| DELETE /leases/:id | ✓ org | ✓ own district | ✓ own district | — | — |
| POST /leases/:id/supersede | ✓ org | ✓ own district | ✓ own district | — | — |
| PATCH /leases/:id/send | ✓ org | ✓ own district | ✓ own district | — | — |
| POST /leases/:id/sign | — | — | — | ✓ own unit | — |
| POST /leases/:id/lessor-sign | ✓ org | ✓ own district | ✓ own district | — | — |
| GET /leases/signature/saved | ✓ org | ✓ own district | ✓ own district | — | — |
| PUT /leases/signature/saved | ✓ org | ✓ own district | ✓ own district | — | — |
| DELETE /leases/signature/saved | ✓ org | ✓ own district | ✓ own district | — | — |
| GET /invoices | ✓ org | ✓ own district | ✓ own district | — | ✓ own |
| POST /invoices | — | — | — | — | ✓ own task |
| POST /invoices/:id/receipts | — | — | — | — | ✓ own |
| DELETE /invoices/:id | — | — | — | — | ✓ own |
| PATCH /invoices/:id/approve | ✓ org | ✓ own district | ✓ own district | — | — |
| PATCH /invoices/:id/reject | ✓ org | ✓ own district | ✓ own district | — | — |
| PATCH /invoices/:id/mark-paid | ✓ org | ✓ own district | ✓ own district | — | — |
| GET /payments | ✓ org | ✓ own district | ✓ own district | ✓ own unit | — |
| PATCH /payments/:id/mark-paid | ✓ org | ✓ own district | ✓ own district | — | — |
| PATCH /payments/:id/mark-outstanding | ✓ org | ✓ own district | ✓ own district | — | — |
| POST /payments/:id/receipts | — | — | — | ✓ own unit | — |
| DELETE /payments/:id/receipts/:receiptId | — | — | — | ✓ own unit | — |
| GET /maintenance | ✓ org | ✓ own district | ✓ own district | ✓ own unit | ✓ own tasks |
| POST /maintenance | — | — | — | ✓ own unit | — |
| PATCH /maintenance/:id/assign | ✓ org | ✓ own district | ✓ own district | — | — |
| PATCH /maintenance/:id/accept | — | — | — | — | ✓ own task |
| PATCH /maintenance/:id/complete | — | — | — | — | ✓ own task |
| GET /complaints | ✓ org | ✓ own district | ✓ own district | — | — |
| POST /complaints | — | — | — | ✓ own unit | — |
| GET /complaints/status/:trackingCode | — | — | — | ✓ public | — |
| GET /complaints/:id | ✓ org | ✓ own district | ✓ own district | — | — |
| PATCH /complaints/:id/resolve | ✓ org | ✓ own district | ✓ own district | — | — |
| PATCH /complaints/:id/reopen | ✓ org | ✓ own district | ✓ own district | — | — |
| GET /emergency | ✓ org | ✓ own district | ✓ own district | — | — |
| POST /emergency | — | — | — | ✓ own unit | — |
| PATCH /emergency/:id/acknowledge | ✓ org | ✓ own district | ✓ own district | — | — |
| PATCH /emergency/:id/resolve | ✓ org | ✓ own district | ✓ own district | — | — |
| GET /evaluations/summary | ✓ org | ✓ own district | ✓ own district | — | — |
| POST /evaluations | ✓ org | ✓ own district | ✓ own district | — | — |
| GET /evaluations/average | ✓ org | ✓ own district | — | — | — |
| GET /audit | ✓ org | ✓ own district | ✓ own district | — | — |
| GET /users/me | ✓ | ✓ | ✓ | ✓ | ✓ |
| PATCH /users/me | ✓ | ✓ | ✓ | ✓ | ✓ |
| GET /users | ✓ org | ✓ own district | ✓ own district | — | — |
| GET /settings | ✓ | ✓ | ✓ | ✓ | ✓ |
| PATCH /settings (business name) | ✓ org | — | — | — | — |
| PATCH /settings/notice-period | ✓ org | — | — | — | — |
| GET /district-info | ✓ org | ✓ own district | ✓ own district | ✓ own district | ✓ own district |
| PUT /district-info/:sectionKey | ✓ org | ✓ own district | ✓ own district | — | — |
| GET /notices | ✓ org | ✓ org (audience) | ✓ org (audience) | ✓ org (tenants) | ✓ org (providers) |
| POST /notices | ✓ org | ✓ own district | ✓ own district | — | — |
| DELETE /notices/:id | ✓ org | ✓ own district | ✓ own district | — | — |
| POST /move-out-notices | — | — | — | ✓ own unit | — |
| GET /move-out-notices/mine | — | — | — | ✓ own | — |
| PATCH /move-out-notices/:id/withdraw | — | — | — | ✓ own | — |
| GET /move-out-notices | ✓ org | ✓ own district | ✓ own district | — | — |
| PATCH /move-out-notices/:id/acknowledge | ✓ org | ✓ own district | ✓ own district | — | — |
| GET /assets | ✓ org | ✓ own district | ✓ own district | ✓ own unit | — |
| POST /assets | ✓ org | ✓ own district | ✓ own district | — | — |
| PATCH /assets/:id | ✓ org | ✓ own district | ✓ own district | — | — |
| DELETE /assets/:id | ✓ org | ✓ own district | ✓ own district | — | — |
| POST /assets/apply-template | ✓ org | ✓ own district | ✓ own district | — | — |
| POST /assets/copy | ✓ org | ✓ own district | ✓ own district | — | — |
| GET /messages | ✓ org | ✓ own district | ✓ own district | ✓ own district | ✓ own district |
| POST /messages | ✓ org | ✓ own district | ✓ own district | ✓ own district | ✓ own district |
| GET /account/deletion-check | ✓ org | — | — | — | — |
| DELETE /account | ✓ org | — | — | — | — |
| GET /notifications/unsubscribe | ✓ public | — | — | — | — |
| POST /notifications/test | ✓ org | — | — | — | — |

Notes:
- District POST/PATCH/DELETE are owner-only (property_manager and admin excluded).
- Business name (PATCH /settings) and notice period (PATCH /settings/notice-period) are owner-only.
- Only the owner may create admin and property_manager codes; admin and property_manager may create only service_provider and tenant codes, in their own district.
- Tenant codes require unit_id and the unit must belong to the chosen district and organisation.
- property_manager is excluded from GET /evaluations/average (that route stays owner/admin only).
- Admin and property_manager cannot see admin, property_manager, or owner codes via GET /codes (only tenant and service_provider codes are visible to them).
