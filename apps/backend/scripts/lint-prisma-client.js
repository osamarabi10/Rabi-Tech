#!/usr/bin/env node

/**
 * Lint rule: prevent 'new PrismaClient()' outside src/prisma/
 * 
 * This ensures all Prisma client instances go through the centralized
 * extension point (src/prisma/index.ts), which is critical for multi-tenancy
 * scoping in Phase 1.
 */

const fs = require('fs');
const path = require('path');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const ALLOWED_DIRS = ['src/prisma', 'scripts'];  // Only these dirs can instantiate PrismaClient
const CHECKED_EXTS = ['.ts', '.tsx', '.js', '.jsx'];

function findBareClientsInFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const errors = [];
  
  // Match: new PrismaClient(...) not inside a comment
  const pattern = /new\s+PrismaClient\s*\(/g;
  
  lines.forEach((line, idx) => {
    // Skip comments
    if (line.trim().startsWith('//') || line.trim().startsWith('*')) return;
    
    if (pattern.test(line)) {
      errors.push({
        file: filePath,
        line: idx + 1,
        message: `Bare 'new PrismaClient()' found. Use src/prisma/index.ts instead.`,
      });
    }
  });
  
  return errors;
}

function checkDirectory(dir) {
  const errors = [];
  
  function walk(currentPath) {
    if (!fs.statSync(currentPath).isDirectory()) {
      if (CHECKED_EXTS.includes(path.extname(currentPath))) {
        // Check if this file is in an allowed directory
        const relPath = path.relative(BACKEND_ROOT, currentPath).replace(/\\/g, '/');
        const isAllowed = ALLOWED_DIRS.some(allowed => relPath.startsWith(allowed));
        
        if (!isAllowed) {
          errors.push(...findBareClientsInFile(currentPath));
        }
      }
      return;
    }
    
    // Skip node_modules and dist
    if (path.basename(currentPath) === 'node_modules' || path.basename(currentPath) === 'dist') {
      return;
    }
    
    fs.readdirSync(currentPath).forEach(file => {
      walk(path.join(currentPath, file));
    });
  }
  
  walk(dir);
  return errors;
}

// Run check
const errors = checkDirectory(path.join(BACKEND_ROOT, 'src'));

if (errors.length > 0) {
  console.error(`\n❌ Lint violations found:\n`);
  errors.forEach(err => {
    console.error(`  ${err.file}:${err.line}`);
    console.error(`    ${err.message}\n`);
  });
  process.exit(1);
} else {
  console.log('✅ No bare PrismaClient() instantiations found outside allowed dirs.');
  process.exit(0);
}
