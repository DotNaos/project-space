import { useEffect } from 'react';

import { installPrototypeAnnotationRuntime } from '../../../src/shared/prototype-annotation-runtime';

export function PrototypeAnnotationBridge() {
  useEffect(() => installPrototypeAnnotationRuntime(), []);
  return null;
}
