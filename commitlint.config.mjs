import projectRules from './scripts/commitlint-rules.mjs';

export default {
  extends: ['@commitlint/config-conventional'],
  defaultIgnores: false,
  plugins: [projectRules],
  rules: {
    'body-leading-blank': [2, 'always'],
    'footer-leading-blank': [2, 'always'],
    'body-max-line-length': [0],
    'footer-max-line-length': [0],
    'project-temporary': [2, 'always'],
    'project-breaking-change': [2, 'always'],
    'project-revert': [2, 'always'],
    'project-header': [2, 'always'],
    'project-scope': [2, 'always'],
  },
};
