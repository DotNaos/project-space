export async function copyText(text: string) {
  const copyValue = text.trim();
  if (!copyValue) return false;

  const canUseAsyncClipboard = typeof window === 'undefined' || window.isSecureContext;
  if (canUseAsyncClipboard && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(copyValue);
      return true;
    } catch {
      // Fall through to the user-gesture copy path below.
    }
  }

  const input = document.createElement('textarea');
  input.value = copyValue;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.inset = '0 auto auto 0';
  input.style.width = '1px';
  input.style.height = '1px';
  input.style.opacity = '0';
  try {
    document.body.append(input);
    input.focus();
    input.select();
    input.setSelectionRange(0, copyValue.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    input.remove();
  }
}
