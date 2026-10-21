const scopes = new Set([
  'project', 'route', 'point', 'planning', 'map', 'import', 'export',
  'storage', 'ui', 'git', 'deps', 'tooling',
]);

const metadata = /^(?:(?:Refs?|Signed-off-by|Co-authored-by|Reviewed-by|Acked-by|Tested-by):|(?:Close[sd]?|Fix(?:e[sd])?|Resolve[sd]?)\s+#)/i;

function hasExplanation(lines, parsed) {
  const retained = new Set([parsed.body, parsed.footer].filter(Boolean).join('\n').split(/\r?\n/));
  return lines.some((line) => retained.has(line) && line.trim() && !/^\s*#/.test(line) && !metadata.test(line));
}

export default {
  rules: {
    'project-revert': (parsed) => {
      const { type, raw } = parsed;
      if (type !== 'revert') return [true];
      const lines = raw.split(/\r?\n/).slice(1);
      const record = /^This reverts commit [0-9a-fA-F]{40}\.$/;
      return [
        lines.some((line) => record.test(line)) && hasExplanation(lines.filter((line) => !record.test(line)), parsed),
        'revert body must contain This reverts commit <40 hexadecimal characters>. on its own line and an actual reason',
      ];
    },
    'project-breaking-change': (parsed) => {
      const { raw } = parsed;
      const lines = raw.split(/\r?\n/);
      const invalidAlias = lines.some((line) => /^\s*BREAKING-CHANGE:/.test(line));
      const markers = lines.flatMap((line, index) => /^\s*BREAKING CHANGE:/.test(line) ? [index] : []);
      const valid = !invalidAlias && markers.every((index) =>
        /^BREAKING CHANGE: \S.*$/.test(lines[index]) &&
        lines[index - 1]?.trim() === '' &&
        lines[index + 1]?.trim() === '' &&
        hasExplanation(lines.slice(index + 2, markers.find((next) => next > index) ?? lines.length), parsed)
      );
      return [valid, 'use BREAKING CHANGE: <summary>, a blank line, then actual migration instructions; do not use BREAKING-CHANGE:'];
    },
    'project-temporary': ({ subject, header }) => [
      ![subject, header].some((text) => /^(?:wip\b|fixup!|squash!|amend!)/i.test(text ?? '')),
      'remove temporary WIP, fixup!, squash!, or amend! prefixes and describe the complete change',
    ],
    'project-header': ({ raw }) => {
      const header = raw.split(/\r?\n/, 1)[0];
      return [
        /^[a-z]+(?:\([a-z]+\))?: [a-z](?:.*[^\s.])?$/.test(header),
        'header must use type(scope): summary with exactly one space; start the summary with a lowercase English letter, omit trailing whitespace and the final period',
      ];
    },
    'project-scope': ({ scope }) => [
      scope === null || scopes.has(scope),
      `scope must be omitted or one of: ${[...scopes].join(', ')}; do not combine scopes`,
    ],
  },
};
