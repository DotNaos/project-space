export function validTopologyRuntimeId(value: string | undefined): value is string {
  return Boolean(value && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value));
}
