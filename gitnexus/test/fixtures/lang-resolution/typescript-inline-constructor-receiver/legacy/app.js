const { LegacyService } = require('./svc');

function viaInlineNewJs() {
  return new LegacyService().doWork();
}

module.exports = { viaInlineNewJs };
