export function isTailscaleClassificationControlDisabled(
  classificationDisabled: boolean,
  pending: boolean
) {
  return classificationDisabled || pending;
}
