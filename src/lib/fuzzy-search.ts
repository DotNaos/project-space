function normalizeSearchValue(value: string) {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ');
}

function fuzzyTokenMatches(value: string, token: string) {
  if (!token) {
    return true;
  }

  if (value.includes(token)) {
    return true;
  }

  let tokenIndex = 0;

  for (const character of value) {
    if (character === token[tokenIndex]) {
      tokenIndex += 1;
    }

    if (tokenIndex === token.length) {
      return true;
    }
  }

  return false;
}

function editDistanceWithin(left: string, right: string, maxDistance: number) {
  if (Math.abs(left.length - right.length) > maxDistance) {
    return false;
  }

  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = Array.from({ length: right.length + 1 }, () => 0);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;
    let rowMinimum = current[0];

    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] + cost
      );

      rowMinimum = Math.min(rowMinimum, current[rightIndex]);
    }

    if (rowMinimum > maxDistance) {
      return false;
    }

    for (let index = 0; index < previous.length; index += 1) {
      previous[index] = current[index];
    }
  }

  return previous[right.length] <= maxDistance;
}

function hasAdjacentTransposition(left: string, right: string) {
  if (left.length !== right.length) {
    return false;
  }

  let mismatchIndex = -1;

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      if (mismatchIndex !== -1) {
        return (
          index === mismatchIndex + 1 &&
          left[mismatchIndex] === right[index] &&
          left[index] === right[mismatchIndex] &&
          left.slice(index + 1) === right.slice(index + 1)
        );
      }

      mismatchIndex = index;
    }
  }

  return false;
}

function valueMatchesToken(value: string, token: string) {
  const normalizedValue = normalizeSearchValue(value);
  const compactValue = normalizedValue.replace(/\s+/g, '');
  const parts = normalizedValue.split(/\s+/).filter(Boolean);
  const initials = normalizedValue
    .split(/\s+/)
    .map((part) => part[0])
    .join('');
  const typoTolerance = token.length >= 5 ? 2 : 1;

  if (normalizedValue.includes(token) || compactValue.includes(token) || initials.includes(token)) {
    return true;
  }

  if (token.length <= 3 && fuzzyTokenMatches(compactValue, token)) {
    return true;
  }

  return parts.some((part) => hasAdjacentTransposition(part, token) || editDistanceWithin(part, token, typoTolerance));
}

export function matchesFuzzyQuery(values: Array<string | undefined>, query: string) {
  const tokens = normalizeSearchValue(query).split(/\s+/).filter(Boolean);

  if (tokens.length === 0) {
    return true;
  }

  const searchValues = values.filter((value): value is string => Boolean(value?.trim()));

  return tokens.every((token) => searchValues.some((value) => valueMatchesToken(value, token)));
}
