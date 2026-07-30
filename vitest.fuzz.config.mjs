export default {
  test: {
    environment: 'node',
    pool: 'forks',
    include: ['src/__tests__/fuzz/**/*.fuzz.test.ts'],
    slowTestThreshold: 5000,
    testTimeout: 30000,
    hookTimeout: 30000,
    reporters: process.env.CI ? ['dot'] : ['default'],
  },
};
