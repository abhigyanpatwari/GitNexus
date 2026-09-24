const { Legacy } = require('./svc');

function viaInlineNewJs() {
  return new Legacy().doWork();
}

module.exports = { viaInlineNewJs };
