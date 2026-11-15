// Use the existing vendored parser, with no npm install or Eleventy build.
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const sandbox = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../cli/src/commands/docs/public/vendor/marked.min.js'), 'utf8'), sandbox);
process.stdout.write(sandbox.marked.parse(fs.readFileSync(0, 'utf8'), { gfm: true }));
