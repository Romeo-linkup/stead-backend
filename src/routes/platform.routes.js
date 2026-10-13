// src/routes/platform.routes.js
// Platform admin API routes - all require platformAuth
const express = require('express');
const router = express.Router();
const platformAuth = require('../middleware/platformAuth');
const {
  platformRateLimit,
  getOverview,
  getOrgs,
  getOrgDetail,
  suspendOrg,
  unsuspendOrg,
  addOrgNote,
  grantDisputeAccess,
  getOrgAudit,
  getLedger,
  verifyLedger,
  exportLedger
} = require('../controllers/platform.controller');

router.use(platformAuth);
router.use(platformRateLimit);

router.get('/overview', getOverview);

router.get('/orgs', getOrgs);
router.get('/orgs/:id', getOrgDetail);
router.post('/orgs/:id/suspend', suspendOrg);
router.post('/orgs/:id/unsuspend', unsuspendOrg);
router.post('/orgs/:id/notes', addOrgNote);
router.post('/orgs/:id/dispute-access', grantDisputeAccess);
router.get('/orgs/:id/audit', getOrgAudit);

router.get('/ledger', getLedger);
router.get('/ledger/verify', verifyLedger);
router.get('/ledger/export.csv', exportLedger);

module.exports = router;
