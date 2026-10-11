import React, { useEffect, useState } from "react";
import { Alert, Button, Modal, ModalBody, ModalFooter, ModalHeader, ModalVariant, Spinner } from "@patternfly/react-core";
import { Table, Tbody, Td, Th, Thead, Tr } from "@patternfly/react-table";
import { CacheFiles, formatSize, getCacheFiles } from "../api";
import { useBackdropClose } from "../hooks/useBackdropClose";
import { usePagination } from "../hooks/usePagination";
import { sanitizeErrorMessage } from "../utils";
import { CompactPagination } from "./CompactPagination";

export const CacheFilesModal: React.FC<{ name: string; onClose: () => void }> = ({ name, onClose }) => {
  useBackdropClose(true, onClose);
  const [data, setData] = useState<CacheFiles | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const { page, perPage, setPage, onSetPage, onPerPageSelect } = usePagination();

  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(async () => {
      if (cancelled) return;
      setLoading(true);
      setError(null);
      try {
        const response = await getCacheFiles(name, (page - 1) * perPage, perPage);
        if (cancelled) return;
        const lastPage = Math.max(1, Math.ceil(response.total / perPage));
        if (page > lastPage) {
          setPage(lastPage);
          return;
        }
        setData(response);
      } catch (ex) {
        if (!cancelled) setError(ex instanceof Error ? ex.message : String(ex));
      } finally {
        if (!cancelled) setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [name, page, perPage, setPage, refresh]);

  return (
    <Modal variant={ModalVariant.large} aria-label={`Cached files for ${name}`} isOpen onClose={onClose}>
      <ModalHeader title={`Cached files for ${name}`} />
      <ModalBody>
        {error !== null && (
          <Alert variant="danger" isInline title="Could not read cached files">
            {sanitizeErrorMessage(error)}
            <Button variant="link" onClick={() => setRefresh(value => value + 1)}>Retry</Button>
          </Alert>
        )}
        {loading && <Spinner aria-label="Loading cached files" />}
        {data !== null && (
          <>
            {data.total === 0 && <p>No cached files remain for this package.</p>}
            <Table aria-label="Cached files" variant="compact" aria-busy={loading}>
              <Thead><Tr><Th>Version</Th><Th>Filename</Th><Th>Size</Th></Tr></Thead>
              <Tbody>
                {data.files.map(file => (
                  <Tr key={file.filename}>
                    <Td dataLabel="Version">{file.version}</Td>
                    <Td dataLabel="Filename"><code>{file.filename}</code></Td>
                    <Td dataLabel="Size">{formatSize(file.size)}</Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
            <CompactPagination itemCount={data.total} page={page} perPage={perPage} onSetPage={onSetPage} onPerPageSelect={onPerPageSelect} />
          </>
        )}
      </ModalBody>
      <ModalFooter><Button variant="link" onClick={onClose}>Close</Button></ModalFooter>
    </Modal>
  );
};
