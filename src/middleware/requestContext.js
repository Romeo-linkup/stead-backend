// src/middleware/requestContext.js
// AsyncLocalStorage holding { ip, userAgent } for each request
const { AsyncLocalStorage } = require('async_hooks');
const contextStorage = new AsyncLocalStorage();

function requestContext(req, res, next) {
  const ip = req.ip;
  const userAgent = (req.headers['user-agent'] || '').substring(0, 200);
  contextStorage.run({ ip, userAgent }, () => next());
}

function getContext() {
  return contextStorage.getStore();
}

module.exports = { requestContext, getContext };
