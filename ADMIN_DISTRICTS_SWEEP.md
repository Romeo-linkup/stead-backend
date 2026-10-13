# Admin Multi-District Sweep

Classification of every `req.user.district_id` / `user.district_id` occurrence in `src/controllers`, `src/services`, `src/routes`, and `src/middleware`.

## Classification codes

- **(a)** Permission/filter comparing a record's district with the caller's district, or a `WHERE district_id = $caller` query — replace with `allowedDistrictIds(req)` (`district_id = ANY($n::int[])`) or `assertDistrictAccess(req, recordDistrictId)`.
- **(b)** Forced district on creation for non-owners — use `resolveTargetDistrict(req, req.body.district_id)` for role admin; property_manager/tenant/service_provider keep their single district.
- **(c)** Org-wide actions where `district_id NULL` means every district of the organisation — allowed only when `canActOrgWide(req)`; otherwise require a `district_id` in `allowedDistrictIds`.
- **(d)** Belongs to a tenant, service_provider, or property_manager flow where one district is correct — leave unchanged.

## Original occurrences and actions

| File | Line | Class | Action taken |
|---|---|---|---|
| src/middleware/auth.js | 87 | d | Comment only. No change. |
| src/middleware/requireRole.js | 5 | d | Comment only. Updated comment text to reflect new logic. |
| src/middleware/requireRole.js | 29 | a | Changed `req.user.district_id !== targetDistrictId` to `allowedDistrictIds(req)` check. Made function `async`. |
| src/controllers/codes.controller.js | 88 | d | property_manager forced district (`Number(req.user.district_id)`). Unchanged. |
| src/controllers/codes.controller.js | 243 | d | property_manager list filter. Unchanged. |
| src/controllers/codes.controller.js | 282 | d | property_manager revoke scope (`code.district_id === req.user.district_id`). Unchanged. |
| src/controllers/districtInfo.controller.js | 37 | b | Added admin branch using `resolveTargetDistrict(req, req.query.district_id)`. property_manager/tenant/service_provider fall through to `req.user.district_id`. |
| src/controllers/districtInfo.controller.js | 87 | b | Added admin branch using `resolveTargetDistrict(req, req.body.district_id)`. |
| src/controllers/properties.controller.js | 56 | b | Added admin branch using `resolveTargetDistrict(req, req.body.district_id)`. |
| src/controllers/invoices.controller.js | 392 | a | Split admin and property_manager branches. Admin now uses `allowedDistrictIds(req)` with `i.district_id = ANY($n::int[])`. property_manager keeps `req.user.district_id`. Added import of `allowedDistrictIds`. |
| src/controllers/invoices.controller.js | 430 | a | Changed `loadManagedInvoice(invoiceId, user, res)` → `loadManagedInvoice(invoiceId, req, res)`. Replaced `user.district_id !== invoice.district_id` check with `allowedDistrictIds(req)` check. Updated 3 call sites. |
| src/controllers/users.controller.js | 107 | d | Audit log (`districtId: user.district_id` in `updateProfile`). Unchanged. |
| src/controllers/users.controller.js | 153 | a | Added admin branch using `allowedDistrictIds(req)` with `u.district_id = ANY($n::int[])`. property_manager/tenant/service_provider keep `req.user.district_id`. |
| src/controllers/users.controller.js | 155 | d | property_manager/tenant/service_provider filter. Unchanged. |
| src/controllers/notices.controller.js | 21 | c | Admin with `all_districts` now treated as org-wide (`orgWideCapable`). Admin without `all_districts` uses `resolveTargetDistrict`. Property_manager/tenant/service_provider fall through to `req.user.district_id`. SQL boolean parameter changed from `isOwner` to `orgWideCapable`. |
| src/controllers/notices.controller.js | 75 | c | Same pattern as getNotices in `createNotice`. Admin with `all_districts` uses owner-style district logic; admin without uses `resolveTargetDistrict`. |
| src/controllers/notices.controller.js | 115 | a | Split owner/admin/property_manager branches. Admin uses `allowedDistrictIds(req)` with `district_id = ANY($n::int[])`. property_manager keeps `req.user.district_id`. |
| src/controllers/notices.controller.js | (new) | - | Added import of `allowedDistrictIds, resolveTargetDistrict, canActOrgWide` from `../utils/scope`. |
| src/controllers/auth.controller.js | 34 | d | JWT payload (`district_id: user.district_id` in `issueFullToken`). User's home district. Unchanged. |
| src/controllers/auth.controller.js | 85 | d | API response (`district_id: user.district_id` in `validateCode`). Unchanged. |
| src/controllers/auth.controller.js | 204 | d | Audit log (`districtId: user.district_id` in `registerName`). Unchanged. |
| src/controllers/auth.controller.js | 220 | d | API response (`district_id: user.district_id` in `signup`). Unchanged. |
| src/controllers/auth.controller.js | 473 | d | API response (`district_id: user.district_id` in `signupPassword`). Unchanged. |
| src/controllers/auth.controller.js | 577 | d | API response (`district_id: user.district_id` in `loginPassword`). Unchanged. |
| src/controllers/settings.controller.js | 51 | d | Audit log (`districtId: req.user.district_id` in `updateSettings`). Unchanged. |
| src/controllers/settings.controller.js | 84 | d | Audit log (`districtId: req.user.district_id` in `updateNoticePeriod`). Unchanged. |
| src/controllers/leases.controller.js | 85 | a | Dead code — `assertScope(user, districtId)` is defined but never called. Uses `user.district_id` for admin/property_manager. Noted; no change (not invoked at runtime). |
| src/controllers/leases.controller.js | 915 | d | Audit log (`districtId: req.user.district_id` in `setSavedSignature`). Unchanged. |
| src/controllers/leases.controller.js | 931 | d | Audit log (`districtId: req.user.district_id` in `removeSavedSignature`). Unchanged. |

## Services reviewed

| File | Finding |
|---|---|
| src/services/audit.service.js | No `req.user.district_id` or `user.district_id` references. Takes `districtId` as parameter from caller. The callers that pass `req.user.district_id` (settings, leases) are class (d) — audit context only. No change needed. |
| src/services/notify.service.js | No `req.user.district_id` or `user.district_id` references. The `recipientsFor` function receives `districtId` as a parameter and handles admin matching in SQL via `c.all_districts`, `code_districts`, and `c.district_id`. Already multi-district aware. No change needed. |

## Remaining occurrences (post-edit grep)

All 25 remaining occurrences are class (d) — user's own `district_id` in JWT/audit/responses, or forced district for property_manager/tenant/service_provider — or dead code (leases `assertScope`):

| File | Line | Class |
|---|---|---|
| src/controllers/auth.controller.js:34 | 34 | d (JWT payload) |
| src/controllers/auth.controller.js:85 | 85 | d (API response) |
| src/controllers/auth.controller.js:204 | 204 | d (audit) |
| src/controllers/auth.controller.js:220 | 220 | d (API response) |
| src/controllers/auth.controller.js:473 | 473 | d (API response) |
| src/controllers/auth.controller.js:577 | 577 | d (API response) |
| src/controllers/codes.controller.js:88 | 88 | d (property_manager only) |
| src/controllers/codes.controller.js:243 | 243 | d (property_manager only) |
| src/controllers/codes.controller.js:282 | 282 | d (property_manager only) |
| src/controllers/districtInfo.controller.js:39 | 39 | d (property_manager only) |
| src/controllers/districtInfo.controller.js:91 | 91 | d (property_manager only) |
| src/controllers/invoices.controller.js:397 | 397 | d (property_manager only) |
| src/controllers/leases.controller.js:85 | 85 | a (dead code — `assertScope` never called) |
| src/controllers/leases.controller.js:915 | 915 | d (audit) |
| src/controllers/leases.controller.js:931 | 931 | d (audit) |
| src/controllers/notices.controller.js:25 | 25 | d (property_manager/tenant/service_provider only) |
| src/controllers/notices.controller.js:81 | 81 | d (property_manager/tenant/service_provider only) |
| src/controllers/notices.controller.js:130 | 130 | d (property_manager only) |
| src/controllers/properties.controller.js:58 | 58 | d (property_manager only) |
| src/controllers/settings.controller.js:51 | 51 | d (audit) |
| src/controllers/settings.controller.js:84 | 84 | d (audit) |
| src/controllers/users.controller.js:107 | 107 | d (audit) |
| src/controllers/users.controller.js:159 | 159 | d (property_manager/tenant/service_provider only) |
| src/controllers/users.controller.js:161 | 161 | d (property_manager/tenant/service_provider only) |
| src/middleware/auth.js:87 | 87 | d (comment) |
