import React, { useState, useMemo } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Content,
  ContentVariants,
  List,
  ListItem,
  Modal,
  ModalVariant,
  ModalHeader,
  ModalBody,
  ModalFooter,
} from "@patternfly/react-core";
import { PreflightResponse, formatSize } from "../api";

interface Props {
  isOpen: boolean;
  preflight: PreflightResponse | null;
  onClose: () => void;
  onProceed: () => void;
}

const ConfirmBody: React.FC<Omit<Props, "isOpen">> = ({ preflight, onClose, onProceed }) => {
  const [acknowledgedRemovals, setAcknowledgedRemovals] = useState(false);
  const [acknowledgedConflicts, setAcknowledgedConflicts] = useState(false);
  const [acknowledgedKeyImports, setAcknowledgedKeyImports] = useState(false);
  const [acknowledgedWarnings, setAcknowledgedWarnings] = useState<Set<string>>(new Set());

  const allDangerousActionsAcknowledged = useMemo(() => {
    if (!preflight) return true;
    const needsRemovalAck = (preflight.removals?.length ?? 0) > 0;
    const needsConflictAck = (preflight.conflicts?.length ?? 0) > 0;
    const needsKeyImportAck = (preflight.import_keys?.length ?? 0) > 0;
    const warningsNeedingAck = (preflight.warnings ?? []).filter(
      (w) => w.severity === "warning" || w.severity === "danger"
    );
    const allWarningsAcked = warningsNeedingAck.every((w) => acknowledgedWarnings.has(w.id));
    return (
      (!needsRemovalAck || acknowledgedRemovals) &&
      (!needsConflictAck || acknowledgedConflicts) &&
      (!needsKeyImportAck || acknowledgedKeyImports) &&
      allWarningsAcked
    );
  }, [preflight, acknowledgedRemovals, acknowledgedConflicts, acknowledgedKeyImports, acknowledgedWarnings]);

  return (
    <Modal
      variant={ModalVariant.medium}
      isOpen
      onClose={onClose}
    >
      <ModalHeader title="Confirm Upgrade" />
      <ModalBody>
        {preflight && (
          <Content>
            <Content component={ContentVariants.p}>
              The following actions will be performed during this upgrade:
            </Content>

            {(preflight.removals?.length ?? 0) > 0 && (
              <Alert variant="danger" title="Packages will be removed" isInline className="pf-v6-u-mt-md">
                <Content component={ContentVariants.p}>
                  The following packages will be removed to resolve dependencies:
                </Content>
                <List>
                  {preflight.removals!.map((pkg) => (
                    <ListItem key={pkg}>{pkg}</ListItem>
                  ))}
                </List>
                <Checkbox
                  id="acknowledge-removals"
                  label="I understand these packages will be removed"
                  isChecked={acknowledgedRemovals}
                  onChange={(_event, checked) => setAcknowledgedRemovals(checked)}
                  className="pf-v6-u-mt-sm"
                />
              </Alert>
            )}

            {(preflight.conflicts?.length ?? 0) > 0 && (
              <Alert variant="warning" title="Package conflicts detected" isInline className="pf-v6-u-mt-md">
                <Content component={ContentVariants.p}>
                  The following conflicts will be resolved automatically:
                </Content>
                <List>
                  {preflight.conflicts!.map((c) => (
                    <ListItem key={`${c.package1}-${c.package2}`}>
                      {c.package1} conflicts with {c.package2}
                    </ListItem>
                  ))}
                </List>
                <Checkbox
                  id="acknowledge-conflicts"
                  label="I understand conflicts will be resolved automatically"
                  isChecked={acknowledgedConflicts}
                  onChange={(_event, checked) => setAcknowledgedConflicts(checked)}
                  className="pf-v6-u-mt-sm"
                />
              </Alert>
            )}

            {(preflight.import_keys?.length ?? 0) > 0 && (
              <Alert variant="warning" title="PGP keys will be imported" isInline className="pf-v6-u-mt-md">
                <Content component={ContentVariants.p}>
                  The following keys will be imported to verify package signatures:
                </Content>
                <List>
                  {preflight.import_keys!.map((k) => (
                    <ListItem key={k.fingerprint}>
                      {k.uid} ({k.fingerprint})
                    </ListItem>
                  ))}
                </List>
                <Checkbox
                  id="acknowledge-key-imports"
                  label="I trust these keys and want to import them"
                  isChecked={acknowledgedKeyImports}
                  onChange={(_event, checked) => setAcknowledgedKeyImports(checked)}
                  className="pf-v6-u-mt-sm"
                />
              </Alert>
            )}

            {preflight.warnings?.map((w) => (
              <Alert
                key={w.id}
                variant={w.severity === "danger" ? "danger" : w.severity === "info" ? "info" : "warning"}
                title={w.title}
                isInline
                className="pf-v6-u-mt-md"
              >
                <Content component={ContentVariants.p}>{w.message}</Content>
                {w.packages.length > 0 && (
                  <List>
                    {w.packages.map((pkg) => (
                      <ListItem key={`${w.id}-${pkg}`}>{pkg}</ListItem>
                    ))}
                  </List>
                )}
                {(w.severity === "warning" || w.severity === "danger") && (
                  <Checkbox
                    id={`acknowledge-warning-${w.id}`}
                    label="I understand and want to proceed"
                    isChecked={acknowledgedWarnings.has(w.id)}
                    onChange={(_event, checked) => {
                      setAcknowledgedWarnings((prev) => {
                        const next = new Set(prev);
                        if (checked) {
                          next.add(w.id);
                        } else {
                          next.delete(w.id);
                        }
                        return next;
                      });
                    }}
                    className="pf-v6-u-mt-sm"
                  />
                )}
              </Alert>
            ))}

            {(preflight.replacements?.length ?? 0) > 0 && (
              <Alert variant="info" title="Package replacements" isInline className="pf-v6-u-mt-md">
                <Content component={ContentVariants.p}>
                  The following packages will be replaced:
                </Content>
                <List>
                  {preflight.replacements!.map((r) => (
                    <ListItem key={`${r.old_package}-${r.new_package}`}>
                      {r.old_package} will be replaced by {r.new_package}
                    </ListItem>
                  ))}
                </List>
              </Alert>
            )}

            {(preflight.providers?.length ?? 0) > 0 && (
              <Alert variant="info" title="Provider selections" isInline className="pf-v6-u-mt-md">
                <Content component={ContentVariants.p}>
                  The first available provider will be selected for the following dependencies:
                </Content>
                <List>
                  {preflight.providers!.map((p) => (
                    <ListItem key={p.dependency}>
                      {p.dependency}: {p.providers[0]} (from: {p.providers.join(", ")})
                    </ListItem>
                  ))}
                </List>
              </Alert>
            )}

            <Content component={ContentVariants.p} className="pf-v6-u-mt-md">
              <strong>{preflight.packages_to_upgrade}</strong> packages will be upgraded
              (download: {formatSize(preflight.total_download_size)})
            </Content>
          </Content>
        )}
      </ModalBody>
      <ModalFooter>
        <Button
          key="confirm"
          variant={(preflight?.removals?.length ?? 0) > 0 || (preflight?.conflicts?.length ?? 0) > 0 ? "danger" : "primary"}
          onClick={onProceed}
          isDisabled={!allDangerousActionsAcknowledged}
        >
          Proceed with Upgrade
        </Button>
        <Button key="cancel" variant="link" onClick={onClose}>
          Cancel
        </Button>
      </ModalFooter>
    </Modal>
  );
};

// Unmounting between opens is what resets the acknowledgement state; do not
// flatten this into a hidden-but-mounted modal.
export const PreflightConfirmModal: React.FC<Props> = ({ isOpen, ...rest }) =>
  isOpen ? <ConfirmBody {...rest} /> : null;
