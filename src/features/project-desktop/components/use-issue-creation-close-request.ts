import { useEffect, useRef } from 'react';

export function useIssueCreationCloseRequest({
  closeRequest,
  onRequestClose,
  open
}: {
  closeRequest: number;
  onRequestClose(): void;
  open: boolean;
}) {
  const handledRequestRef = useRef(closeRequest);

  useEffect(() => {
    if (!open || closeRequest === handledRequestRef.current) return;
    handledRequestRef.current = closeRequest;
    onRequestClose();
  }, [closeRequest, onRequestClose, open]);
}
