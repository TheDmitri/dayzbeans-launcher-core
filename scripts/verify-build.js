/**
 * Build Verification Script
 * Verifies that all required build outputs exist
 */

const fs = require('fs');
const path = require('path');

console.log('🔍 Verifying build outputs...\n');

const requiredDirs = [
  'dist-angular/dayz-launcher/browser',
  'dist-electron'
];

const requiredFiles = [
  'dist-angular/dayz-launcher/browser/index.html',
  'dist-electron/electron/main.js',
  'dist-electron/electron/preload.js'
];

const requiredPatterns = [
  // Angular 19+ uses main-HASH.js format instead of main.HASH.js
  { dir: 'dist-angular/dayz-launcher/browser', pattern: /^main[-.].*\.js$/ }
];

let allGood = true;

// Check directories
console.log('📁 Checking directories...');
requiredDirs.forEach(dir => {
  if (!fs.existsSync(dir)) {
    console.error(`  ❌ Missing directory: ${dir}`);
    allGood = false;
  } else {
    const files = fs.readdirSync(dir);
    console.log(`  ✅ Found ${dir} (${files.length} files)`);
  }
});

console.log('');

// Check critical files
console.log('📄 Checking critical files...');
requiredFiles.forEach(file => {
  if (fs.existsSync(file)) {
    const stats = fs.statSync(file);
    console.log(`  ✅ ${file} (${(stats.size / 1024).toFixed(2)} KB)`);
  } else {
    console.error(`  ❌ Missing: ${file}`);
    allGood = false;
  }
});

console.log('');

// Check file patterns
console.log('🔎 Checking file patterns...');
requiredPatterns.forEach(({ dir, pattern }) => {
  if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir);
    const found = files.find(f => pattern.test(f));
    if (found) {
      const stats = fs.statSync(path.join(dir, found));
      console.log(`  ✅ ${found} (${(stats.size / 1024).toFixed(2)} KB)`);
    } else {
      console.error(`  ❌ No file matching ${pattern} in ${dir}`);
      allGood = false;
    }
  }
});

console.log('');

if (!allGood) {
  console.error('❌ Build verification failed!\n');
  process.exit(1);
}

console.log('✅ Build verification passed!\n');
