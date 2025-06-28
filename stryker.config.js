/**
 * @type {import('@stryker-mutator/api/core').StrykerOptions}
 */
module.exports = {
  packageManager: 'npm',
  testRunner: 'jest',
  jest: {
    projectType: 'custom',
    configFile: 'jest.config.js',
    enableFindRelatedTests: true,
  },
  mutate: [
    'src/**/*.ts',
    '!src/**/__tests__/**/*.ts',
    '!src/**/*.test.ts',
    '!src/**/*.spec.ts',
    '!src/test-utils/**/*.ts',
    '!src/index.ts',
    '!src/bootstrap.ts',
    '!src/db/types.ts',
    '!src/**/*.d.ts',
  ],
  checkers: ['typescript'],
  tsconfigFile: 'tsconfig.json',
  testRunnerNodeArgs: ['--experimental-vm-modules'],
  timeoutMS: 60000,
  timeoutFactor: 1.5,
  maxConcurrentTestRunners: 4,
  coverageAnalysis: 'perTest',
  mutator: {
    name: 'typescript',
    excludedMutations: [
      'ArrayDeclaration',
      'ObjectLiteral',
      'StringLiteral',
    ],
  },
  thresholds: {
    high: 80,
    low: 60,
    break: 50,
  },
  clearTextReporter: {
    maxTestsToLog: 3,
    allowColor: true,
  },
  htmlReporter: {
    fileName: 'reports/mutation/index.html',
  },
  jsonReporter: {
    fileName: 'reports/mutation/report.json',
  },
  dashboard: {
    project: 'github.com/businesswalrus/pupper',
    version: 'main',
    reportType: 'full',
  },
  disableTypeChecks: false,
  warnings: true,
  plugins: [
    '@stryker-mutator/jest-runner',
    '@stryker-mutator/typescript-checker',
    '@stryker-mutator/html-reporter',
    '@stryker-mutator/json-reporter',
    '@stryker-mutator/dashboard-reporter',
  ],
};