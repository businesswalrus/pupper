#!/usr/bin/env node

/**
 * Railway deployment validation script
 * Run this before deploying to ensure your environment is correctly configured
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('🚂 Railway Deployment Validator\n');

const errors = [];
const warnings = [];
const successes = [];

// Check Node version
function checkNodeVersion() {
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.split('.')[0].substring(1));
  
  if (major < 18) {
    errors.push(`Node.js version ${nodeVersion} is too old. Railway requires Node 18+`);
  } else if (major === 18) {
    warnings.push(`Node.js ${nodeVersion} is supported but consider upgrading to Node 20`);
  } else {
    successes.push(`✓ Node.js ${nodeVersion} is fully supported`);
  }
}

// Check required files exist
function checkRequiredFiles() {
  const requiredFiles = [
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'railway.toml',
    'Dockerfile.railway.v2',
    'scripts/start-railway.js',
    'scripts/railway-health.js'
  ];
  
  requiredFiles.forEach(file => {
    const filePath = path.join(process.cwd(), file);
    if (fs.existsSync(filePath)) {
      successes.push(`✓ Found ${file}`);
    } else {
      errors.push(`Missing required file: ${file}`);
    }
  });
}

// Check package.json configuration
function checkPackageJson() {
  try {
    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    
    // Check engines
    if (!packageJson.engines || !packageJson.engines.node) {
      warnings.push('No Node.js engine specified in package.json');
    } else {
      successes.push(`✓ Node engine specified: ${packageJson.engines.node}`);
    }
    
    // Check critical scripts
    const requiredScripts = ['build', 'start'];
    requiredScripts.forEach(script => {
      if (packageJson.scripts && packageJson.scripts[script]) {
        successes.push(`✓ Script '${script}' defined`);
      } else {
        errors.push(`Missing required script: ${script}`);
      }
    });
    
    // Check for problematic dependencies
    const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
    if (deps['ts-node']) {
      warnings.push('ts-node found in dependencies - ensure it\'s not needed in production');
    }
    
  } catch (error) {
    errors.push(`Failed to read package.json: ${error.message}`);
  }
}

// Check TypeScript configuration
function checkTypeScript() {
  try {
    const tsConfig = JSON.parse(fs.readFileSync('tsconfig.json', 'utf8'));
    
    if (tsConfig.compilerOptions.outDir !== 'dist') {
      warnings.push(`TypeScript outDir is '${tsConfig.compilerOptions.outDir}', expected 'dist'`);
    } else {
      successes.push('✓ TypeScript configured to output to dist/');
    }
    
    // Check if paths are configured
    if (tsConfig.compilerOptions.paths) {
      successes.push('✓ TypeScript path aliases configured');
      
      // Check if tsconfig-paths is installed
      try {
        require.resolve('tsconfig-paths');
        successes.push('✓ tsconfig-paths is installed');
      } catch {
        errors.push('tsconfig-paths not found but path aliases are configured');
      }
    }
    
  } catch (error) {
    errors.push(`Failed to read tsconfig.json: ${error.message}`);
  }
}

// Check environment variables
function checkEnvironmentVariables() {
  console.log('\n📋 Environment Variables Check:');
  
  const required = [
    'DATABASE_URL',
    'REDIS_URL',
    'SLACK_BOT_TOKEN',
    'SLACK_APP_TOKEN',
    'SLACK_SIGNING_SECRET',
    'OPENAI_API_KEY'
  ];
  
  const optional = [
    'RAILWAY_ENVIRONMENT',
    'PORT',
    'NODE_ENV',
    'SKIP_MIGRATIONS'
  ];
  
  // In local environment, just warn about missing vars
  required.forEach(envVar => {
    if (process.env[envVar]) {
      console.log(`  ✓ ${envVar} is set`);
    } else {
      console.log(`  ⚠️  ${envVar} is not set (required in Railway)`);
      warnings.push(`Set ${envVar} in Railway dashboard before deploying`);
    }
  });
  
  optional.forEach(envVar => {
    if (process.env[envVar]) {
      console.log(`  ✓ ${envVar} is set to: ${process.env[envVar]}`);
    } else {
      console.log(`  ℹ️  ${envVar} is not set (optional)`);
    }
  });
}

// Check Docker build
function checkDockerBuild() {
  console.log('\n🐳 Docker Build Check:');
  
  try {
    // Check if Docker is installed
    execSync('docker --version', { stdio: 'ignore' });
    console.log('  ✓ Docker is installed');
    
    // Try to build the Railway Dockerfile
    console.log('  🔨 Testing Docker build (this may take a moment)...');
    try {
      execSync('docker build -f Dockerfile.railway.v2 -t railway-test --build-arg BUILD_TIMESTAMP=test .', {
        stdio: 'pipe'
      });
      successes.push('✓ Docker build successful');
      
      // Clean up test image
      execSync('docker rmi railway-test', { stdio: 'ignore' });
    } catch (buildError) {
      errors.push('Docker build failed - fix errors before deploying');
      console.error('  ❌ Build error:', buildError.message);
    }
    
  } catch {
    warnings.push('Docker not installed - cannot validate build locally');
  }
}

// Check migrations
function checkMigrations() {
  const migrationsDir = path.join(process.cwd(), 'migrations');
  
  if (fs.existsSync(migrationsDir)) {
    const migrations = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql'));
    if (migrations.length > 0) {
      successes.push(`✓ Found ${migrations.length} migration files`);
    } else {
      warnings.push('No migration files found in migrations directory');
    }
  } else {
    errors.push('Migrations directory not found');
  }
}

// Main validation
console.log('🔍 Checking deployment readiness...\n');

checkNodeVersion();
checkRequiredFiles();
checkPackageJson();
checkTypeScript();
checkMigrations();
checkEnvironmentVariables();
checkDockerBuild();

// Summary
console.log('\n📊 Validation Summary:');
console.log('====================\n');

if (successes.length > 0) {
  console.log('✅ Passed Checks:');
  successes.forEach(msg => console.log(`  ${msg}`));
}

if (warnings.length > 0) {
  console.log('\n⚠️  Warnings:');
  warnings.forEach(msg => console.log(`  - ${msg}`));
}

if (errors.length > 0) {
  console.log('\n❌ Errors (must fix before deploying):');
  errors.forEach(msg => console.log(`  - ${msg}`));
}

// Railway-specific tips
console.log('\n💡 Railway Deployment Tips:');
console.log('  1. Set all environment variables in Railway dashboard');
console.log('  2. Use "railway up" to deploy from CLI');
console.log('  3. Monitor logs with "railway logs"');
console.log('  4. Check deployment status at https://railway.app');
console.log('  5. If deployment fails, check build logs in Railway dashboard');

// Exit code
if (errors.length > 0) {
  console.log('\n❌ Validation failed - fix errors before deploying');
  process.exit(1);
} else if (warnings.length > 0) {
  console.log('\n⚠️  Validation passed with warnings');
  process.exit(0);
} else {
  console.log('\n✅ All checks passed - ready to deploy!');
  process.exit(0);
}