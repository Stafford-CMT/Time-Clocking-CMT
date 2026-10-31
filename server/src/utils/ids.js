'use strict';

// Same shape as the ids the browser prototype generated client-side
// (e.g. `contract-${Date.now()}`) -- kept so existing data/ids already in a
// browser tab stay compatible with what the server now mints.
function uid(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = { uid };
