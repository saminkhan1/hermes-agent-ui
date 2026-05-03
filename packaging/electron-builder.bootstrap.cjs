'use strict';

const pkg = require('../package.json');

module.exports = {
  ...pkg.build,
  artifactName: 'agent-UI-${version}-${os}-${arch}-bootstrap.${ext}',
  mac: {
    ...pkg.build.mac,
    identity: '-',
    gatekeeperAssess: false,
    notarize: false,
  },
  dmg: {
    ...pkg.build.dmg,
    sign: false,
  },
};
