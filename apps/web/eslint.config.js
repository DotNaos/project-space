import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // ESLint supports max-lines natively.
      // Since a single rule only accepts one severity level,
      // we usually set it as a warning for the soft limit
      // or error for the hard limit.
      // Here we set the hard limit as an error:
      'max-lines': ['error', { max: 700, skipBlankLines: true, skipComments: true }],
      // A soft limit (<500) would require custom plugin or multiple configs, but
      // practically, teams often enforce the hard limit here.
    }
  }
);
