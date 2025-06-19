// This file sets up tsconfig-paths before loading the main application
// It ensures that TypeScript path aliases work in the compiled JavaScript

const tsConfigPaths = require('tsconfig-paths');
const path = require('path');

// Register tsconfig-paths with the correct baseUrl for production
const baseUrl = __dirname; // This will be /app/dist in production
tsConfigPaths.register({
  baseUrl,
  paths: {
    '@bot/*': ['bot/*'],
    '@ai/*': ['ai/*'],
    '@db/*': ['db/*'],
    '@mcp/*': ['mcp/*'],
    '@workers/*': ['workers/*'],
    '@utils/*': ['utils/*'],
    '@services/*': ['services/*']
  }
});

// Now load the main application
require('./index');