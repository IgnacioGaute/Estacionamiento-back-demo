const path = require('node:path');
require('tsconfig-paths').register({ baseUrl: path.resolve(__dirname, '../dist'), paths: { 'src/*': ['*'] } });
require('../dist/main');
