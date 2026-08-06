import { useCallback, useRef, useState } from "react";

export function prototypeDesignMeasurementsEqual(
  current: unknown,
  next: unknown,
) {
  return current === next || JSON.stringify(current) === JSON.stringify(next);
}

export function usePrototypeDesignMeasuredState<Value>() {
  const [value, setValue] = useState<Value | null>(null);
  const signature = useRef(JSON.stringify(null));
  const setMeasuredValue = useCallback((next: Value | null) => {
    const nextSignature = JSON.stringify(next);
    if (signature.current === nextSignature) return;
    signature.current = nextSignature;
    setValue(next);
  }, []);
  return [value, setMeasuredValue] as const;
}
