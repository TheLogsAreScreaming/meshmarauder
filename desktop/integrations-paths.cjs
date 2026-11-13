'use strict';
// Where integrations.json and the assistant token live. Computed without
// Electron so the assistant link (run as plain Node) finds the same folder.
const os = require('node:os');
const path = require('node:path');

function integrationsDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.MESH_MARAUDER_INTEGRATIONS_DIR) return env.MESH_MARAUDER_INTEGRATIONS_DIR;
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Mesh Marauder', 'integrations');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'mesh-marauder', 'integrations');
}

module.exports = { integrationsDir };
