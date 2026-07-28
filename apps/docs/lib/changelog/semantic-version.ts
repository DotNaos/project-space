import changelogSchema from '@/content/docs/changelog/schema.json';

const semanticVersionPattern = new RegExp(
  changelogSchema.semanticVersionPattern,
);

export function isChangelogVersion(value: string) {
  return semanticVersionPattern.test(value);
}

export function compareChangelogVersions(left: string, right: string) {
  const [leftPrecedence] = left.split('+', 1);
  const [rightPrecedence] = right.split('+', 1);
  const leftSeparator = leftPrecedence.indexOf('-');
  const rightSeparator = rightPrecedence.indexOf('-');
  const leftCore =
    leftSeparator === -1
      ? leftPrecedence
      : leftPrecedence.slice(0, leftSeparator);
  const rightCore =
    rightSeparator === -1
      ? rightPrecedence
      : rightPrecedence.slice(0, rightSeparator);
  const leftPrerelease =
    leftSeparator === -1
      ? []
      : leftPrecedence.slice(leftSeparator + 1).split('.');
  const rightPrerelease =
    rightSeparator === -1
      ? []
      : rightPrecedence.slice(rightSeparator + 1).split('.');

  const leftCoreParts = leftCore.split('.').map(Number);
  const rightCoreParts = rightCore.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const comparison = leftCoreParts[index]! - rightCoreParts[index]!;
    if (comparison !== 0) return comparison;
  }

  if (leftPrerelease.length === 0 || rightPrerelease.length === 0) {
    if (leftPrerelease.length === rightPrerelease.length) return 0;
    return leftPrerelease.length === 0 ? 1 : -1;
  }

  for (
    let index = 0;
    index < Math.max(leftPrerelease.length, rightPrerelease.length);
    index += 1
  ) {
    const leftPart = leftPrerelease[index];
    const rightPart = rightPrerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === undefined ? -1 : 1;
    }
    const leftNumeric = /^[0-9]+$/.test(leftPart);
    const rightNumeric = /^[0-9]+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      const comparison = Number(leftPart) - Number(rightPart);
      if (comparison !== 0) return comparison;
      continue;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    const comparison = leftPart.localeCompare(rightPart);
    if (comparison !== 0) return comparison;
  }
  return 0;
}
