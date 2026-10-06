# Organization Scoping Inventory

This document tracks the scoping of every route before and after organization isolation.

| Method | Path | Roles | Before Scoping | After Scoping |
|--------|------|-------|----------------|--------------|
| GET | /auth/config | public | N/A | N/A |
| POST | /auth/validate-code | public | N/A | N/A |
| POST | /auth/register-name | public | N/A | N/A |
| POST | /auth/refresh | public | N/A | N/A |
| POST | /auth/signup | public | N/A | N/A |
| POST | /auth/login-password | public | N/A | N/A |
| GET | /districts | owner, admin, property_manager | owner: all districts; admin/PM: own district_id | owner: org's districts; admin/PM: own district_id if in org |
| POST | /districts | owner | Creates district without org_id | Creates district with org_id = orgId(req) |
| DELETE | /districts/:id | owner, admin | district_id check only | organization_id check + district_id check |
| GET | /codes | owner, admin, property_manager | owner: all codes; admin: own district_id | owner: org's codes; admin/PM: own district_id if in org, filtered to tenant/service_provider roles only |
| POST | /codes | owner, admin, property_manager | district belongs to user's district | district belongs to user's org; saves org_id and created_by |
| PATCH | /codes/:id/revoke | owner, admin, property_manager | district_id check + self-revoke | org_id check + district_id check + self-revoke |
| GET | /properties | owner, admin | owner: all properties; admin: own district_id | owner: org's properties; admin: own district_id if in org |
| POST | /properties | owner, admin | district_id check (owner exempt) | district belongs to user's org (owner exempt to use any org district) |
| GET | /units | owner, admin | owner: all units; admin: own district_id | owner: org's units; admin: own district_id if in org |
| POST | /units | owner, admin | district_id check (owner exempt) | district belongs to user's org (owner exempt to use any org district) |
| GET | /units/:id | owner, admin, property_manager, tenant | district_id/tenant check | district_id belongs to org + existing checks |
| GET | /units/me | tenant | own unit only | own unit only (already scoped) |
| GET | /leases | owner, admin, property_manager, tenant | owner: all leases; admin/PM: own district_id; tenant: own unit | owner: org's leases; admin/PM: own district_id if in org; tenant: own unit |
| POST | /leases | owner, admin, property_manager | district_id check (owner exempt) | district belongs to user's org (owner exempt to use any org district) |
| GET | /leases/:id | owner, admin, property_manager, tenant | district_id/tenant check | district_id belongs to org + existing checks |
| PATCH | /leases/:id | owner, admin, property_manager | district_id check (owner exempt) | district belongs to user's org (owner exempt to use any org district) |
| DELETE | /leases/:id | owner, admin, property_manager | district_id check (owner exempt) | district belongs to user's org (owner exempt to use any org district) |
| POST | /leases/:id/supersede | owner, admin, property_manager | district_id check (owner exempt) | district belongs to user's org (owner exempt to use any org district) |
| PATCH | /leases/:id/send | owner, admin, property_manager | district_id check (owner exempt) | district belongs to user's org (owner exempt to use any org district) |
| POST | /leases/:id/sign | tenant | tenant on unit check | tenant on unit check (already scoped) |
| POST | /leases/:id/lessor-sign | owner, admin, property_manager | district_id check (owner exempt) | district belongs to user's org (owner exempt to use any org district) |
| GET | /leases/signature/saved | owner, admin, property_manager | No scoping (lessor signature) | Keyed by req.user.user_id (per-user, implicitly org-scoped via auth) |
| PUT | /leases/signature/saved | owner, admin, property_manager | No scoping (lessor signature) | Keyed by req.user.user_id (per-user, implicitly org-scoped via auth) |
| DELETE | /leases/signature/saved | owner, admin, property_manager | No scoping (lessor signature) | Keyed by req.user.user_id (per-user, implicitly org-scoped via auth) |
| GET | /invoices | owner, admin, property_manager, service_provider | owner: all invoices; admin/PM: own district_id; provider: own assignments | owner: org's invoices; admin/PM: own district_id if in org; provider: own assignments |
| POST | /invoices | service_provider | district_id from task | district_id from task must be in org |
| POST | /invoices/:id/receipts | service_provider | own invoice only | own invoice only (already scoped) |
| DELETE | /invoices/:id | service_provider | own invoice only | own invoice only (already scoped) |
| PATCH | /invoices/:id/approve | owner, admin, property_manager | district_id check (owner exempt) | district belongs to user's org (owner exempt to use any org district) |
| PATCH | /invoices/:id/reject | owner, admin, property_manager | district_id check (owner exempt) | district belongs to user's org (owner exempt to use any org district) |
| PATCH | /invoices/:id/mark-paid | owner, admin, property_manager | district_id check (owner exempt) | district belongs to user's org (owner exempt to use any org district) |
| GET | /payments | owner, admin, tenant | owner: all payments; admin: own district_id; tenant: own unit | owner: org's payments; admin: own district_id if in org; tenant: own unit |
| PATCH | /payments/:id/mark-paid | admin | district_id check | district belongs to org |
| PATCH | /payments/:id/mark-outstanding | admin | district_id check | district belongs to org |
| GET | /maintenance | owner, admin, property_manager, tenant, service_provider | owner: all requests; admin/PM: own district_id; tenant: own unit; provider: own assignments | owner: org's requests; admin/PM: own district_id if in org; tenant: own unit; provider: own assignments |
| POST | /maintenance | tenant | own unit only | own unit only (already scoped) |
| PATCH | /maintenance/:id/assign | owner, admin, property_manager | district_id check (owner exempt) | district belongs to user's org (owner exempt to use any org district) |
| PATCH | /maintenance/:id/accept | service_provider | own assignment only | own assignment only (already scoped) |
| PATCH | /maintenance/:id/complete | service_provider | own assignment only | own assignment only (already scoped) |
| GET | /complaints | owner, admin, property_manager | owner: all complaints; admin/PM: own district_id | owner: org's complaints; admin/PM: own district_id if in org |
| POST | /complaints | tenant | own unit only | own unit only (already scoped) |
| GET | /complaints/status/:trackingCode | tenant | Public tracking code | Public tracking code; district_id must be in caller's allowed districts (404 otherwise) |
| GET | /complaints/:id | owner, admin, property_manager | district_id check (owner exempt) | district belongs to user's org (owner exempt to use any org district) |
| PATCH | /complaints/:id/resolve | owner, admin, property_manager | district_id check (owner exempt) | district belongs to user's org (owner exempt to use any org district) |
| PATCH | /complaints/:id/reopen | owner, admin, property_manager | district_id check (owner exempt) | district belongs to user's org (owner exempt to use any org district) |
| GET | /emergency | owner, admin, property_manager | owner: all alerts; admin/PM: own district_id | owner: org's alerts; admin/PM: own district_id if in org |
| POST | /emergency | tenant | own unit only | own unit only (already scoped) |
| PATCH | /emergency/:id/acknowledge | owner, admin, property_manager | district_id check (owner exempt) | district belongs to user's org (owner exempt to use any org district) |
| PATCH | /emergency/:id/resolve | owner, admin, property_manager | district_id check (owner exempt) | district belongs to user's org (owner exempt to use any org district) |
| GET | /evaluations/summary | owner, admin, property_manager | owner: all districts; admin/PM: own district_id | owner: org's districts; admin/PM: own district_id if in org |
| POST | /evaluations | owner, admin, property_manager | district_id check (owner exempt) | district belongs to user's org (owner exempt to use any org district) |
| GET | /evaluations/average | owner, admin | owner: all districts; admin: own district_id | owner: org's districts; admin: own district_id if in org |
| GET | /audit | owner, admin, property_manager | owner: all audit; admin/PM: own district_id | owner: org's audit; admin/PM: own district_id if in org |
| GET | /users/me | all | own profile only | own profile only (already scoped) |
| PATCH | /users/me | all | own profile only | own profile only (already scoped) |
| GET | /users | owner, admin, property_manager | owner: all users (with role filter); admin/PM: own district_id | owner: org's users; admin/PM: own district_id if in org |
| GET | /settings | all | Global settings row | Org's settings row (fallback to defaults) |
| PATCH | /settings | owner, admin, property_manager | Global settings row | Org's settings row (create if missing) |
| PATCH | /settings/notice-period | owner, admin | Global settings row | Org's settings row (create if missing) |
| GET | /district-info | owner, admin, property_manager, tenant, service_provider | district_id check (owner exempt) | district belongs to user's org (owner exempt to use any org district) |
| PUT | /district-info/:sectionKey | owner, admin, property_manager | district_id check (owner exempt) | district belongs to user's org (owner exempt to use any org district) |
| GET | /notices | all | Global/district with audience rules | Org-wide with audience rules (district_id NULL = all org districts) |
| POST | /notices | owner, admin, property_manager | district_id optional, no org | Saves org_id, district_id belongs to org |
| DELETE | /notices/:id | owner, admin, property_manager | district_id check (owner exempt) | org_id check + district_id check |
| POST | /move-out-notices | tenant | own unit only | own unit only (already scoped) |
| GET | /move-out-notices/mine | tenant | own notice only | own notice only (already scoped) |
| PATCH | /move-out-notices/:id/withdraw | tenant | own notice only | own notice only (already scoped) |
| GET | /move-out-notices | owner, admin, property_manager | owner: all notices; admin/PM: own district_id | owner: org's notices; admin/PM: own district_id if in org |
| PATCH | /move-out-notices/:id/acknowledge | owner, admin, property_manager | district_id check (owner exempt) | district belongs to user's org (owner exempt to use any org district) |
| GET | /messages | all | district_id only | district_id only (already scoped) |
| POST | /messages | all | district_id only | district_id only (already scoped) |
| PATCH | /properties/:id | owner, admin, property_manager | Not in inventory | district belongs to user's org (owner exempt to use any org district) |
| DELETE | /properties/:id | owner, admin, property_manager | Not in inventory | district belongs to user's org (owner exempt to use any org district) |
| PATCH | /units/:id | owner, admin, property_manager | Not in inventory | district belongs to user's org (owner exempt to use any org district) |
| DELETE | /units/:id | owner, admin, property_manager | Not in inventory | district belongs to user's org (owner exempt to use any org district) |
| POST | /units/bulk | owner, admin, property_manager | Not in inventory | district belongs to user's org (owner exempt to use any org district) |
| GET | /assets | owner, admin, property_manager, tenant | Not in inventory | owner: org's units; admin/PM: own district_id if in org; tenant: own unit |
| POST | /assets | owner, admin, property_manager | Not in inventory | district belongs to user's org (owner exempt to use any org district) |
| PATCH | /assets/:id | owner, admin, property_manager | Not in inventory | district belongs to user's org (owner exempt to use any org district) |
| DELETE | /assets/:id | owner, admin, property_manager | Not in inventory | district belongs to user's org (owner exempt to use any org district) |
| POST | /assets/apply-template | owner, admin, property_manager | Not in inventory | district belongs to user's org (owner exempt to use any org district) |
| POST | /assets/copy | owner, admin, property_manager | Not in inventory | district belongs to user's org (owner exempt to use any org district) |
| POST | /payments/:id/receipts | tenant | Not in inventory | own payment only (tenant on unit check, already scoped) |
| DELETE | /payments/:id/receipts/:receiptId | tenant | Not in inventory | own payment only (tenant on unit check, already scoped) |
