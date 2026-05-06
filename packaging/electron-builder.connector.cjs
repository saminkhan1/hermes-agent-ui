'use strict';

const { makeConfig } = require('./electron-builder.shared.cjs');

module.exports = makeConfig({ appMode: 'connector', signingMode: 'developer-id' });
