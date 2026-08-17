/**
 * Pre-build validation script
 * Checks that all required files exist before building
 */

const fs = require('fs');
const path = require('path');

console.log('🔍 Running pre-build checks...\n');

// Check required files
const requiredFiles = [
  'src/electron/app.ts',
  'src/electron/preload.ts',
  'src/electron/main.ts',
  'src/environments/environment.prod.ts',
  '.env',
  'package.json',
  'tsconfig.electron.json',
  'electron-builder.json'
];

let allGood = true;

requiredFiles.forEach(file => {
  if (!fs.existsSync(file)) {
    console.error(`❌ Missing required file: ${file}`);
    allGood = false;
  } else {
    console.log(`✅ Found: ${file}`);
  }
});

// Check required directories
const requiredDirs = [
  'src/electron',
  'src/app',
  'src/assets'
];

requiredDirs.forEach(dir => {
  if (!fs.existsSync(dir)) {
    console.error(`❌ Missing required directory: ${dir}`);
    allGood = false;
  } else {
    console.log(`✅ Found: ${dir}`);
  }
});

console.log('');

if (!allGood) {
  console.error('❌ Pre-build checks failed! Please fix the issues above.');
  process.exit(1);
}

console.log('✅ All pre-build checks passed!\n');
