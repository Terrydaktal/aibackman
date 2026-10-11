const fs = require('fs');
const path = require('path');
const dependencyRoot = path.resolve(__dirname, '..', '..', 'fuzzy-rank');
// Source deployments without the sibling ranking crate keep the existing LIKE
// fallback; deployments with the crate compile before opening the application.
if (fs.existsSync(path.join(dependencyRoot, 'Cargo.toml'))) require('../electron/database.cjs').ensureDbSearchBinary();
