import { ErrorDetails } from "./ErrorDetails";
import React, { useEffect, useId, useRef, useState } from "react";
import {
  Alert,
  AlertActionCloseButton,
  Button,
  CodeBlock,
  CodeBlockCode,
  Content,
  ContentVariants,
  ExpandableSection,
  Flex,
  FlexItem,
  List,
  ListItem,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalVariant,
  Spinner,
} from "@patternfly/react-core";
import type { ConfigFileEditor, OutsideNotice } from "../hooks/useConfigFileEditor";
import type { MutationGate } from "../hooks/useMutationGate";
import { useBackdropClose } from "../hooks/useBackdropClose";
import { plural, sanitizeErrorMessage } from "../utils";
import { GatedButton } from "./GatedButton";
import { RefreshFailedAlert } from "./LoadErrorState";
import { UndoAlert } from "./UndoAlert";

interface ConfigWriteAlertsProps<T> {
  editor: ConfigFileEditor<T>;
  /** Short file name for titles and buttons, such as "pacman.conf". */
  fileLabel: string;
  notSavedTitle: string;
  saveBlockedReason: string | null;
  restoreGate: MutationGate;
}

function timeOf(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function ConfigWriteAlerts<T>({
  editor, fileLabel, notSavedTitle, saveBlockedReason, restoreGate,
}: ConfigWriteAlertsProps<T>) {
  const forceTitleId = useId();
  const restoreTitleId = useId();
  const noticeChangesId = useId();
  const reappliedRef = useRef<HTMLDivElement>(null);
  const [expandedNotice, setExpandedNotice] = useState<OutsideNotice | null>(null);
  const forceOpen = editor.outsideChange !== null;
  const {
    saveError, configChanged, restoreError, reapplied, lastWrite, discarded, outsideChange,
    outsideNotice, refreshError, restoreConflict,
  } = editor;
  const sources = `for example ${editor.changeSources}`;
  const showNoticeChanges = outsideNotice !== null && expandedNotice === outsideNotice;
  useBackdropClose(forceOpen, editor.closeForceSave);
  useBackdropClose(restoreConflict !== null, editor.cancelRestore);

  // The reapply action unmounts with its alert; keep focus near the result.
  // An outside change arrives unasked, so focus stays where the user is.
  useEffect(() => {
    if (reapplied && !reapplied.outside) reappliedRef.current?.querySelector<HTMLElement>("button")?.focus();
  }, [reapplied]);

  return (
    <>
      {saveError && (
        <Alert
          variant="danger"
          isInline
          title={configChanged ? `${editor.file} changed since you started editing` : notSavedTitle}
          className="pf-v6-u-mb-md"
          actionLinks={configChanged ? (
            <>
              <Button variant="link" isInline onClick={editor.reapply}>
                Reload and reapply my {plural(editor.pendingChanges.length, "change")}
              </Button>
              <GatedButton disabledReason={saveBlockedReason} variant="link" isInline onClick={editor.openForceSave}>
                Save my version anyway
              </GatedButton>
            </>
          ) : (
            <GatedButton disabledReason={saveBlockedReason} variant="link" isInline onClick={() => editor.save()}>
              Try again
            </GatedButton>
          )}
        >
          {configChanged
            ? `The change may come from this page or elsewhere (${sources}). Nothing was written. Reapplying reads the file as it is now and makes your changes again on top of it.`
            : sanitizeErrorMessage(saveError.message)}{" "}
          Your changes are still here.
          <ErrorDetails details={saveError.details} />
        </Alert>
      )}
      {refreshError && (
        <RefreshFailedAlert
          what={fileLabel}
          error={editor.hasChanges
            ? `${refreshError} Your ${plural(editor.pendingChanges.length, "unsaved change")} ${editor.pendingChanges.length === 1 ? "is" : "are"} still here.`
            : refreshError}
          details={editor.refreshErrorDetails}
          onRetry={editor.retryRefresh}
        />
      )}
      {outsideNotice && !reapplied && (
        <Alert
          variant="info"
          isInline
          isPlain
          title={`${fileLabel} changed at ${timeOf(outsideNotice.at)}`}
          className="pf-v6-u-mb-md"
          actionClose={<AlertActionCloseButton title={`${fileLabel} changed`} onClose={editor.dismissOutsideNotice} />}
          actionLinks={outsideNotice.changes.length > 0 ? (
            <Button
              variant="link"
              isInline
              aria-expanded={showNoticeChanges}
              aria-controls={noticeChangesId}
              onClick={() => setExpandedNotice(showNoticeChanges ? null : outsideNotice)}
            >
              {showNoticeChanges ? "Hide changes" : "Show changes"}
            </Button>
          ) : undefined}
        >
          The table shows the file as it is now ({sources}).
          {outsideNotice.changes.length === 0 && " The change is in lines this page does not show, such as comments or options."}
          <div id={noticeChangesId} hidden={!showNoticeChanges}>
            <List className="pf-v6-u-mt-sm">
              {outsideNotice.changes.map((c) => <ListItem key={c}>{c}</ListItem>)}
            </List>
          </div>
        </Alert>
      )}
      {restoreError && (
        <Alert
          variant="danger"
          isInline
          title={`${editor.file} not restored`}
          className="pf-v6-u-mb-md"
          actionClose={<AlertActionCloseButton title={`${editor.file} not restored`} onClose={editor.dismissRestoreError} />}
          actionLinks={
            <GatedButton gate={restoreGate} disabledReason={editor.lockReason} variant="link" isInline onClick={editor.retryRestore}>
              Try again
            </GatedButton>
          }
        >
          {sanitizeErrorMessage(restoreError.message)} The file was not changed.
          <ErrorDetails details={restoreError.details} />
        </Alert>
      )}
      {reapplied && (
        <div ref={reappliedRef}>
          <Alert
            variant={reapplied.skipped.length > 0 ? "warning" : "info"}
            isInline
            title={reapplied.outside
              ? `${fileLabel} changed since you started editing`
              : reapplied.skipped.length > 0
                ? `${plural(reapplied.skipped.length, "change")} no longer ${reapplied.skipped.length === 1 ? "applies" : "apply"}`
                : `Reapplied ${plural(reapplied.applied, "change")} to the current file`}
            className="pf-v6-u-mb-md"
            actionClose={<AlertActionCloseButton onClose={editor.dismissReapplied} />}
          >
            {reapplied.outside && (
              <Content component={ContentVariants.p} className="pf-v6-u-mb-sm">
                The change may come from this page or elsewhere ({sources}).
              </Content>
            )}
            {reapplied.outside && reapplied.applied > 0 && (
              <Content component={ContentVariants.p} className="pf-v6-u-mb-sm">
                Your {plural(reapplied.applied, "change")} {reapplied.applied === 1 ? "was" : "were"} reapplied
                to the file as it is now.
              </Content>
            )}
            {reapplied.outside && reapplied.skipped.length > 0 && (
              <Content component={ContentVariants.p}>
                {plural(reapplied.skipped.length, "change")} no longer {reapplied.skipped.length === 1 ? "applies" : "apply"}:
              </Content>
            )}
            {reapplied.skipped.length > 0 && (
              <List className="pf-v6-u-mb-sm">
                {reapplied.skipped.map((s) => <ListItem key={s}>{s}</ListItem>)}
              </List>
            )}
            {reapplied.applied === 0
              ? "Nothing is left to save."
              : !reapplied.outside &&
                `${plural(reapplied.applied, "change")} ${reapplied.applied === 1 ? "is" : "are"} ready to save on top of the current file.`}
          </Alert>
        </div>
      )}
      <UndoAlert
        variant={discarded ? "info" : "success"}
        title={discarded ? "Changes discarded" : lastWrite?.title ?? null}
        onUndo={discarded ? editor.undoDiscard : lastWrite?.backupTimestamp != null && lastWrite.revision ? editor.undo : undefined}
        gate={discarded ? undefined : restoreGate}
        disabledReason={discarded
          ? editor.hasChanges && "You have made new changes since discarding"
          : editor.hasChanges ? "Save or discard your changes first" : editor.lockReason}
        onClose={discarded ? editor.dismissDiscarded : editor.dismissLastWrite}
      />
      <Modal
        variant={ModalVariant.small}
        isOpen={forceOpen}
        onClose={editor.closeForceSave}
        aria-labelledby={forceTitleId}
      >
        <ModalHeader title={`Replace ${fileLabel}?`} labelId={forceTitleId} titleIconVariant="warning" />
        <ModalBody>
          <Content component={ContentVariants.p}>
            <code>{editor.file}</code> changed since you started editing ({sources}). Saving your version
            replaces those changes. The current file is backed up first.
          </Content>
          {outsideChange?.status === "loading" ? (
            <Spinner size="md" aria-label={`Reading ${editor.file}`} />
          ) : outsideChange?.status === "failed" ? (
            <>
              <Content component={ContentVariants.p}>
                The current file could not be read: {sanitizeErrorMessage(outsideChange.message)}
              </Content>
              <ErrorDetails details={outsideChange.details} />
            </>
          ) : outsideChange?.status === "ready" && outsideChange.changes.length > 0 ? (
            <>
              <Content component={ContentVariants.p}>Changed since you started editing:</Content>
              <List>
                {outsideChange.changes.map((c) => <ListItem key={c}>{c}</ListItem>)}
              </List>
            </>
          ) : outsideChange?.status === "ready" ? (
            <Content component={ContentVariants.p}>
              The outside change is in lines this page does not show, such as comments or options.
            </Content>
          ) : null}
        </ModalBody>
        <ModalFooter>
          <GatedButton disabledReason={saveBlockedReason ?? (outsideChange?.status !== "ready" ? "Read the current file before replacing it" : null)} variant="danger" onClick={editor.forceSave}>
            Replace {fileLabel}
          </GatedButton>
          <Button variant="link" onClick={editor.closeForceSave}>Cancel</Button>
        </ModalFooter>
      </Modal>
      <Modal
        variant={ModalVariant.small}
        isOpen={restoreConflict !== null}
        onClose={editor.cancelRestore}
        aria-labelledby={restoreTitleId}
      >
        <ModalHeader title={`Restore over the changed ${fileLabel}?`} labelId={restoreTitleId} titleIconVariant="warning" />
        <ModalBody>
          <Content component={ContentVariants.p}>
            <code>{editor.file}</code> changed since this page last read it ({sources}).
            Restoring replaces these changes:
          </Content>
          <List className="pf-v6-u-my-sm">
            {restoreConflict?.changes.map((c) => <ListItem key={c}>{c}</ListItem>)}
          </List>
          <Content component={ContentVariants.p}>The current file is backed up first.</Content>
        </ModalBody>
        <ModalFooter>
          <GatedButton gate={restoreGate} disabledReason={editor.lockReason} variant="danger" onClick={editor.confirmRestore}>
            Replace changes and restore
          </GatedButton>
          <Button variant="link" onClick={editor.cancelRestore}>Cancel</Button>
        </ModalFooter>
      </Modal>
    </>
  );
}

interface ConfigPendingChangesProps<T> {
  editor: ConfigFileEditor<T>;
  renderText: () => string;
  textCaption: string;
  onDiscard: () => void;
}

export function ConfigPendingChanges<T>({ editor, renderText, textCaption, onDiscard }: ConfigPendingChangesProps<T>) {
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const [textExpanded, setTextExpanded] = useState(false);
  const n = editor.pendingChanges.length;
  if (n === 0) return null;
  return (
    <Flex
      alignItems={{ default: "alignItemsFlexStart" }}
      spaceItems={{ default: "spaceItemsMd" }}
      className="pf-v6-u-mb-md"
    >
      <FlexItem grow={{ default: "grow" }}>
        <ExpandableSection
          toggleText={`Pending changes (${n})`}
          isExpanded={expanded ?? n <= 5}
          onToggle={(_event, value) => setExpanded(value)}
        >
          <List isPlain>
            {editor.pendingChanges.map((change) => (
              <ListItem key={change}>{change}</ListItem>
            ))}
          </List>
          <ExpandableSection
            toggleText="View result as text"
            isExpanded={textExpanded}
            onToggle={(_event, value) => setTextExpanded(value)}
            className="pf-v6-u-mt-sm"
          >
            <Content component={ContentVariants.p} className="pf-v6-u-mb-sm">{textCaption}</Content>
            {textExpanded && (
              <CodeBlock>
                <CodeBlockCode>{renderText()}</CodeBlockCode>
              </CodeBlock>
            )}
          </ExpandableSection>
        </ExpandableSection>
      </FlexItem>
      <FlexItem>
        <GatedButton variant="link" disabledReason={editor.lockReason} onClick={onDiscard}>
          Discard changes
        </GatedButton>
      </FlexItem>
    </Flex>
  );
}

interface RestoreGuardModalProps {
  isOpen: boolean;
  file: string;
  fileLabel: string;
  changes: string[];
  backupDate: string | undefined;
  onConfirm: () => void;
  onCancel: () => void;
}

export const RestoreGuardModal: React.FC<RestoreGuardModalProps> = ({
  isOpen, file, fileLabel, changes, backupDate, onConfirm, onCancel,
}) => {
  const titleId = useId();
  useBackdropClose(isOpen, onCancel);
  return (
    <Modal variant={ModalVariant.small} isOpen={isOpen} onClose={onCancel} aria-labelledby={titleId}>
      <ModalHeader title={`Restore ${fileLabel} backup?`} labelId={titleId} titleIconVariant="warning" />
      <ModalBody>
        Your {plural(changes.length, "unsaved change")} to {fileLabel} will be lost:
        <List className="pf-v6-u-my-sm">
          {changes.map((change) => <ListItem key={change}>{change}</ListItem>)}
        </List>
        The current {file} is backed up first
        {backupDate ? `, then replaced with the backup from ${backupDate}.` : "."}
      </ModalBody>
      <ModalFooter>
        <Button variant="danger" onClick={onConfirm}>Discard changes and restore</Button>
        <Button variant="link" onClick={onCancel}>Cancel</Button>
      </ModalFooter>
    </Modal>
  );
};
