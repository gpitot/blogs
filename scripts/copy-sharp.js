const { cpSync, existsSync } = require('fs');
const { join } = require('path');

const buildDir = join(__dirname, '..', '.aws-sam', 'build');
const nodeModules = join(__dirname, '..', 'node_modules');
const functions = ['ApiFunction', 'WeeklyFunction'];

for (const fn of functions) {
  const dest = join(buildDir, fn, 'node_modules');

  // Copy sharp
  cpSync(join(nodeModules, 'sharp'), join(dest, 'sharp'), { recursive: true });

  // Copy all @img/sharp-* linux-arm64 packages (native binding + libvips)
  for (const pkg of ['sharp-linux-arm64', 'sharp-libvips-linux-arm64']) {
    const src = join(nodeModules, '@img', pkg);
    if (existsSync(src)) {
      cpSync(src, join(dest, '@img', pkg), { recursive: true });
    }
  }

  // Copy other sharp dependencies
  for (const dep of ['color', 'color-convert', 'color-name', 'color-string', 'detect-libc', 'is-arrayish', 'semver', 'simple-swizzle']) {
    const src = join(nodeModules, dep);
    if (existsSync(src)) {
      cpSync(src, join(dest, dep), { recursive: true });
    }
  }
}

console.log('Copied sharp native binaries to build output');
