// The audit log notes each record opened (docs/adr/0019-signatures-and-audit-log.md); the core
// notes each once a sign-in.
import { useEffect } from 'react';
import { api, type Kind } from './api';

/** Notes in the audit log that a record was opened. A note that fails does not stop the page. */
export function useOpened(kind: Kind, recordId: string | undefined) {
  useEffect(() => {
    if (recordId) api.note({ action: 'opened', kind, record: recordId }).catch(() => {});
  }, [kind, recordId]);
}
