#!/usr/bin/env node
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const real = fs.realpathSync(__filename);
const pkgDir = path.dirname(path.dirname(real));
const tsx = path.join(pkgDir, 'node_modules', '.bin', 'tsx');
const repl = path.join(pkgDir, 'src', 'agent', 'index.ts');

const child = spawn(tsx, [repl, ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 0));
