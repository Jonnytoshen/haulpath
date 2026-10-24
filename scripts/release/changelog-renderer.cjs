const DefaultRenderer = require('nx/release/changelog-renderer').default;

// Nx owns change selection and revert pairing. Preserve migration headings that
// its default renderer treats as the end of a breaking-change explanation.
module.exports = class HaulPathChangelogRenderer extends DefaultRenderer {
  extractBreakingChangeExplanation(body) {
    if (!body) return null;
    const marker = body.indexOf('BREAKING CHANGE:');
    if (marker < 0) return null;
    return body.slice(marker + 'BREAKING CHANGE:'.length)
      .replace(/<!--[^]*?-->/g, '')
      .split(/\n(?=\s*"\s*(?:\n|$)|(?:Refs:|Fixes |Closes |Signed-off-by:|Co-authored-by:))/i)[0].trim();
  }
};
