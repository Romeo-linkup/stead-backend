// src/server.js — app entrypoint
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const errorHandler = require('./middleware/errorHandler');
const authRoutes = require('./routes/auth.routes');
const districtsRoutes = require('./routes/districts.routes');
const codesRoutes = require('./routes/codes.routes');
const propertiesRoutes = require('./routes/properties.routes');
const unitsRoutes = require('./routes/units.routes');
const leasesRoutes = require('./routes/leases.routes');
const invoicesRoutes = require('./routes/invoices.routes');
const paymentsRoutes = require('./routes/payments.routes');
const maintenanceRoutes = require('./routes/maintenance.routes');
const assetsRoutes = require('./routes/assets.routes');
const complaintsRoutes = require('./routes/complaints.routes');
const emergencyRoutes = require('./routes/emergency.routes');
const auditRoutes = require('./routes/audit.routes');
const evaluationsRoutes = require('./routes/evaluations.routes');
const usersRoutes = require('./routes/users.routes');
const settingsRoutes = require('./routes/settings.routes');
const districtInfoRoutes = require('./routes/districtInfo.routes');
const noticesRoutes = require('./routes/notices.routes');
const moveOutRoutes = require('./routes/moveOut.routes');

const app = express();

app.set('trust proxy', 1);
app.use(cors({ origin: process.env.CORS_ORIGIN || "http://localhost:3000" }));
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true, service: 'stead-backend' }));

app.use('/auth', authRoutes);
app.use('/districts', districtsRoutes);
app.use('/codes', codesRoutes);
app.use('/properties', propertiesRoutes);
app.use('/units', unitsRoutes);
app.use('/leases', leasesRoutes);
app.use('/invoices', invoicesRoutes);
app.use('/payments', paymentsRoutes);
app.use('/maintenance', maintenanceRoutes);
app.use('/assets', assetsRoutes);
app.use('/complaints', complaintsRoutes);
app.use('/emergency', emergencyRoutes);
app.use('/audit', auditRoutes);
app.use('/evaluations', evaluationsRoutes);
app.use('/users', usersRoutes);
app.use('/settings', settingsRoutes);
app.use('/app-settings', settingsRoutes);
app.use('/district-info', districtInfoRoutes);
app.use('/notices', noticesRoutes);
app.use('/move-out-notices', moveOutRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
app.use(errorHandler);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`[stead-backend] listening on port ${PORT}`);
});
