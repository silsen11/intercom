/**
 * Script de validación de sintaxis y calidad de código
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('🔍 Ejecutando linter y verificación de sintaxis...');

const jsFiles = [
  path.join(__dirname, '..', 'server', 'signal-server.js'),
  path.join(__dirname, '..', 'public', 'sw.js'),
  path.join(__dirname, 'generate-icons.js'),
  path.join(__dirname, 'lint.js')
];

let hasErrors = false;

for (const file of jsFiles) {
  if (fs.existsSync(file)) {
    try {
      execSync(`node --check "${file}"`, { stdio: 'pipe' });
      console.log(`  ✓ Sintaxis correcta: ${path.relative(path.join(__dirname, '..'), file)}`);
    } catch (err) {
      console.error(`  ✗ Error de sintaxis en: ${file}`);
      hasErrors = true;
    }
  }
}

if (hasErrors) {
  process.exit(1);
}

console.log('✅ Lint completado sin errores.');
process.exit(0);
