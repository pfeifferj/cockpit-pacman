import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Alert, Button, Content, ContentVariants, FormGroup, FormSelect, FormSelectOption,
  Grid, GridItem, List, ListItem, Modal, ModalBody, ModalFooter, ModalHeader,
  ModalVariant, Spinner, TextArea, ToggleGroup, ToggleGroupItem,
} from "@patternfly/react-core";
import {
  getPacnewStatus, previewPacnew, resolvePacnew,
  type PacnewFile, type PacnewPreview, type PacnewResolveRequest, type PacnewResolveResponse, type PacnewStatus,
} from "../api";
import { configurationDiff, type ConfigDiffLine } from "../configDiff";
import { useAnnounce } from "../contexts/AnnouncerContext";
import { useAdminPermission } from "../hooks/useAdminPermission";
import { useBackdropClose } from "../hooks/useBackdropClose";
import { useMutationGate } from "../hooks/useMutationGate";
import { ErrorAlert } from "./ErrorAlert";
import { GatedButton } from "./GatedButton";
import { toLoadFailure, type LoadFailure } from "./LoadErrorState";

interface Props {
  files: PacnewFile[];
  onClose: () => void;
  /** Receives each administrative scan, including the one after an applied choice. */
  onScanned: (status: PacnewStatus) => void;
}

type Resolution = PacnewResolveRequest["resolution"];
type Intent = { kind: "close" } | { kind: "select"; path: string } | { kind: "discard" } |
  { kind: "resolve"; resolution: Resolution };
type View = "changes" | "files" | "edit";

const EMPTY_EDITOR = { path: "", text: "", baseline: "" };
const BACKUP_LOCATION = "/etc/.cockpit-pacman-backups";

const codeStyle: React.CSSProperties = {
  overflow: "auto", maxHeight: "24rem", whiteSpace: "pre", padding: "0.75rem",
  border: "1px solid var(--pf-t--global--border--color--default)",
};

const DIFF_STYLE: Record<ConfigDiffLine["kind"], { prefix: string; color?: string }> = {
  removed: { prefix: "−", color: "var(--pf-t--global--text--color--status--danger--default)" },
  added: { prefix: "+", color: "var(--pf-t--global--text--color--status--success--default)" },
  context: { prefix: " " },
};

const crlfOnly = (text: string) => text.includes("\r\n") && !/(?<!\r)\n/.test(text);
// A textarea reports every line ending as LF, so per-line endings cannot be restored.
const mixedEndings = (text: string) => text.includes("\r\n") && /(?<!\r)\n/.test(text);

function discardLabel(intent: Intent, saved: boolean): string {
  if (intent.kind !== "resolve") return "Discard edits";
  if (intent.resolution === "keep_current") return "Discard edits and keep current";
  return saved ? "Discard edits and restore saved version" : "Discard edits and use new version";
}

export const ConfigReconciliationModal: React.FC<Props> = ({ files: initialFiles, onClose, onScanned }) => {
  const id = useId();
  const announce = useAnnounce();
  const permission = useAdminPermission();
  const gate = useMutationGate("review configuration files", { permission });
  const [files, setFiles] = useState(initialFiles);
  const [selected, setSelected] = useState(initialFiles[0]?.path ?? "");
  const [loadedPreview, setLoadedPreview] = useState<PacnewPreview | null>(null);
  const [view, setView] = useState<View>("changes");
  const [editor, setEditor] = useState(EMPTY_EDITOR);
  const draft = editor.text;
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [previewError, setPreviewError] = useState<LoadFailure | null>(null);
  const [saveError, setSaveError] = useState<(LoadFailure & { body: PacnewResolveRequest }) | null>(null);
  const [scanError, setScanError] = useState<LoadFailure | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Stale until a preview from a later reload attempt loads; an access change reloads the same attempt.
  const [staleAt, setStaleAt] = useState<number | null>(null);
  const stale = staleAt !== null;
  const [scanAttempt, setScanAttempt] = useState(0);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [result, setResult] = useState<PacnewResolveResponse | null>(null);
  const [backups, setBackups] = useState<string[]>([]);
  const dirty = draft !== editor.baseline;
  const manual = selected !== "" && !selected.startsWith("/etc/");
  const preview = loadedPreview?.path === selected && !manual ? loadedPreview : null;
  const previewing = permission === true && selected !== "" && !manual;
  const previewKey = `${attempt}\n${selected}`;
  const loading = previewing && loadedKey !== previewKey;

  useEffect(() => {
    if (permission !== true) return;
    let dropped = false;
    getPacnewStatus(true).then(status => {
      if (dropped) return;
      onScanned(status);
      setFiles(status.files);
      setWarnings(status.warnings ?? []);
      setScanError(null);
      setSelected(path => path || status.files[0]?.path || "");
    }, ex => { if (!dropped) setScanError(toLoadFailure(ex)); });
    return () => { dropped = true; };
  }, [permission, scanAttempt, onScanned]);

  useEffect(() => {
    if (!previewing) return;
    const controller = new AbortController();
    let dropped = false;
    previewPacnew(selected, controller.signal).then(data => {
      if (dropped) return;
      setLoadedPreview(data);
      setPreviewError(null);
      setStaleAt(at => at === attempt ? at : null);
      setLoadedKey(previewKey);
      const text = data.current_content ?? data.pending_content;
      setEditor(previous => previous.path === data.path && previous.text !== previous.baseline
        ? { ...previous, baseline: text }
        : { path: data.path, text, baseline: text });
    }, ex => {
      if (dropped) return;
      setPreviewError(toLoadFailure(ex));
      setLoadedKey(previewKey);
    });
    return () => { dropped = true; controller.abort(); };
  }, [previewing, previewKey, selected, attempt]);

  const discardButton = useRef<React.ComponentRef<"button"> | null>(null);
  useEffect(() => {
    if (!intent) return;
    announce("Discard your unsaved edits?");
    discardButton.current?.focus();
  }, [intent, announce]);

  useEffect(() => {
    if (!dirty && !busy) return;
    const warn = (event: Event) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, busy]);

  // A retry resends this exact request, so a file that changed meanwhile is rejected as stale.
  // The gate is not checked: a lock retry fires on release, before the gate clears, and
  // the backend takes the lock itself.
  const submit = async (body: PacnewResolveRequest) => {
    if (!preview || loading || stale || running.current) return;
    running.current = true;
    setBusy(true);
    setIntent(null);
    setSaveError(null);
    try {
      const response = await resolvePacnew(body);
      setResult(response);
      announce(response.message);
      setBackups(paths => [...paths, ...response.backup_paths]);
      setEditor(EMPTY_EDITOR);
      setView("changes");
      setLoadedPreview(null);
      setSelected("");
      setScanAttempt(value => value + 1);
    } catch (ex) {
      const failure = toLoadFailure(ex);
      setSaveError({ ...failure, body });
      if (failure.code === "config_changed") setStaleAt(attempt);
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  const apply = (resolution: Resolution) => preview && submit({
    path: preview.path, revision: preview.revision, resolution,
    ...(resolution === "save_merged" ? { merged_content: draft } : {}),
  });

  // A successful retry resets the editor, so editing after a failure cancels the retry.
  const cancelRetry = () => setSaveError(error => error?.code === "config_changed" ? error : null);

  const perform = (next: Intent) => {
    if (running.current) return;
    setIntent(null);
    if (next.kind === "close") onClose();
    else if (next.kind === "resolve") void apply(next.resolution);
    else if (next.kind === "select") {
      setLoadedPreview(null);
      setPreviewError(null);
      setSaveError(null);
      setStaleAt(null);
      setSelected(next.path);
      setEditor(EMPTY_EDITOR);
      setView("changes");
    } else {
      cancelRetry();
      setEditor(previous => ({ ...previous, text: previous.baseline }));
      setView("changes");
    }
  };
  const request = (next: Intent) => {
    if (running.current) return;
    if (next.kind === "select" && next.path === selected) return;
    if (dirty) setIntent(next);
    else perform(next);
  };
  const close = () => request({ kind: "close" });
  useBackdropClose(true, close);

  const reload = () => {
    if (running.current) return;
    setSaveError(null);
    setScanAttempt(value => value + 1);
    setAttempt(value => value + 1);
  };

  const diff = useMemo(() => preview ? configurationDiff(preview.current_content ?? "", preview.pending_content) : null, [preview]);
  const saved = preview?.kind === "pacsave";
  const mixed = mixedEndings(editor.baseline);
  const blockedReason = busy ? "Applying the previous choice"
    : loading ? "Loading the configuration"
    : stale ? "Reload the files before choosing again"
    : intent ? "Choose whether to discard your unsaved edits first"
    : null;
  const owner = files.find(file => file.path === selected)?.package;
  const sourceLabel = saved ? "Saved configuration" : "New configuration";

  return (
    <Modal variant={ModalVariant.large} isOpen onClose={close} aria-labelledby={`${id}-title`}>
      <ModalHeader title="Review configuration files" labelId={`${id}-title`} />
      <ModalBody>
        {intent && (
          <Alert isInline variant="warning" component="h2" title="Discard your unsaved edits?" className="pf-v6-u-mb-md">
            <Button ref={discardButton} variant="danger" onClick={() => perform(intent)} isDisabled={busy}>{discardLabel(intent, saved)}</Button>{" "}
            <Button variant="link" onClick={() => setIntent(null)} isDisabled={busy}>Continue editing</Button>
          </Alert>
        )}
        {result && (
          <Alert isInline variant={result.warnings.length ? "warning" : "success"} component="h2" title={result.message} className="pf-v6-u-mb-md">
            {result.warnings.map((warning, i) => <p key={i}>{warning}</p>)}
            {backups.length > 0 && <><p>Backups from this review:</p><List>{backups.map(path => <ListItem key={path} style={{ overflowWrap: "anywhere" }}>{path}</ListItem>)}</List></>}
          </Alert>
        )}
        {warnings.length > 0 && <Alert isInline variant="warning" component="h2" title="Some paths were skipped" className="pf-v6-u-mb-md"><List>{warnings.map((warning, i) => <ListItem key={i}>{warning}</ListItem>)}</List></Alert>}
        {scanError && (
          <ErrorAlert isInline headingLevel="h2" className="pf-v6-u-mb-md" title="Could not list configuration files"
            error={scanError.message} code={scanError.code} details={scanError.details}
            onRetry={() => setScanAttempt(value => value + 1)} showRetry />
        )}
        {saveError && (saveError.code === "config_changed" ? (
          <Alert isInline variant="danger" component="h2" title="The configuration changed" className="pf-v6-u-mb-md">
            <p>The files changed after they were shown. Reload them, then choose again.</p>
            <Button variant="link" isInline onClick={reload} isDisabled={busy}>Reload files</Button>
            {dirty && <p>Your edited text will be kept when you reload. Review it against the latest files before saving.</p>}
          </Alert>
        ) : (
          <ErrorAlert isInline headingLevel="h2" className="pf-v6-u-mb-md" title="Could not apply the choice"
            error={saveError.message} code={saveError.code} details={saveError.details}
            onRetry={() => void submit(saveError.body)} showRetry />
        ))}
        {previewError && !loading && (
          <ErrorAlert isInline headingLevel="h2" className="pf-v6-u-mb-md" title="Could not read the configuration"
            error={previewError.code === "validation_error" ? `${previewError.message}. Review this file manually, for example with pacdiff.` : previewError.message}
            code={previewError.code} details={previewError.details} onRetry={reload} showRetry />
        )}
        {permission !== true ? <Alert isInline variant="info" component="h2" title={gate.reason ?? "Administrative access is required"} /> : files.length === 0 && !selected && !loading ? (
          <Content component={ContentVariants.p}>{warnings.length ? "No configuration files can be reviewed here." : "No configuration files need review."}</Content>
        ) : (
          <FormGroup label="Configuration file" fieldId={`${id}-file`}>
            <FormSelect id={`${id}-file`} value={selected} isDisabled={busy || loading} onChange={(_event, path) => request({ kind: "select", path })}>
              {selected !== "" && !files.some(file => file.path === selected) && <FormSelectOption value={selected} label={selected} />}
              {files.map(file => <FormSelectOption key={file.path} value={file.path} label={file.path} />)}
            </FormSelect>
          </FormGroup>
        )}
        {manual && permission === true && (
          <Alert isInline variant="info" component="h2" title="Review this file manually" className="pf-v6-u-mt-md" style={{ overflowWrap: "anywhere" }}>
            {selected} is outside /etc. Compare and merge it yourself, for example with pacdiff.
          </Alert>
        )}
        {loading && <p className="pf-v6-u-mt-md"><Spinner size="sm" aria-label="Loading configuration" /></p>}
        {preview && !loading && (
          <>
            <Content component={ContentVariants.p} className="pf-v6-u-mt-md" style={{ overflowWrap: "anywhere" }}>
              <strong>{preview.current_path}</strong>{owner && ` (${owner})`}
            </Content>
            {preview.current_content === null && <Alert isInline variant="info" component="h2" title="There is no current file" className="pf-v6-u-mb-md">Keeping the current state leaves this path absent. {saved ? "Restore the saved configuration to recreate it." : "Use the new configuration to create it."}</Alert>}
            <ToggleGroup aria-label="Configuration view" className="pf-v6-u-mb-md">
              <ToggleGroupItem text={<span style={{ whiteSpace: "nowrap" }}>Changes</span>} buttonId={`${id}-changes`} isSelected={view === "changes"} onChange={() => setView("changes")} />
              <ToggleGroupItem text="Files" buttonId={`${id}-files`} isSelected={view === "files"} onChange={() => setView("files")} />
              <ToggleGroupItem text="Edit" aria-label="Edit merged result" buttonId={`${id}-edit`} isSelected={view === "edit"} onChange={() => setView("edit")} />
            </ToggleGroup>
            {view === "changes" && diff && (diff.lines.length === 0 ? <p>{diff.truncated ? "Too many lines changed to list here. Open Files to compare the complete contents." : "The files have identical contents."}</p> : <>
              <p>− Current configuration · + {sourceLabel.toLowerCase()}</p>
              <pre role="region" tabIndex={0} aria-label="Configuration changes" style={codeStyle}>
                {diff.lines.map((line, i) => <span key={i} style={{ display: "block", color: DIFF_STYLE[line.kind].color }}>{DIFF_STYLE[line.kind].prefix} {line.text}</span>)}
              </pre>
              {diff.truncated && <p>The diff is shortened. Open Files to compare the complete contents.</p>}
            </>)}
            {view === "files" && <Grid hasGutter>
              <GridItem span={12} lg={6} style={{ minWidth: 0 }}><p><strong>Current configuration</strong></p><pre role="region" tabIndex={0} aria-label="Current configuration" style={codeStyle}>{preview.current_content ?? "(File absent)"}</pre></GridItem>
              <GridItem span={12} lg={6} style={{ minWidth: 0 }}><p><strong>{sourceLabel}</strong></p><pre role="region" tabIndex={0} aria-label={sourceLabel} style={codeStyle}>{preview.pending_content}</pre></GridItem>
            </Grid>}
            {view === "edit" && mixed && (
              <Alert isInline variant="info" component="h2" title="Merge this file manually">
                This file mixes CRLF and LF line endings, which the editor cannot keep. Merge it yourself, for example with pacdiff.
              </Alert>
            )}
            {view === "edit" && !mixed && <FormGroup label="Merged configuration" fieldId={`${id}-merged`}>
              <TextArea id={`${id}-merged`} value={draft} rows={14} isDisabled={busy} resizeOrientation="vertical"
                onChange={(_event, value) => {
                  cancelRetry();
                  setEditor(previous => ({ ...previous, text: crlfOnly(previous.baseline) ? value.replace(/\r?\n/g, "\r\n") : value }));
                }}
                style={{ fontFamily: "monospace", whiteSpace: "pre", overflow: "auto" }} />
              <Button variant="link" isInline onClick={() => request({ kind: "discard" })} isDisabled={busy}>Discard merged edits</Button>
            </FormGroup>}
            <Content component={ContentVariants.p} className="pf-v6-u-mt-md">Files you replace or remove are backed up under {BACKUP_LOCATION}.</Content>
          </>
        )}
      </ModalBody>
      <ModalFooter>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
        {preview && view === "edit" ? (
          <GatedButton gate={gate} variant="primary" disabledReason={blockedReason ?? (mixed && "Merge this file manually")} isLoading={busy} onClick={() => apply("save_merged")}>Save merge</GatedButton>
        ) : preview && <>
          <GatedButton gate={gate} variant="primary" disabledReason={blockedReason} isLoading={busy} onClick={() => request({ kind: "resolve", resolution: "use_pending" })}>{saved ? "Restore saved version" : "Use new version"}</GatedButton>
          <GatedButton gate={gate} variant="secondary" disabledReason={blockedReason} onClick={() => request({ kind: "resolve", resolution: "keep_current" })}>Keep current</GatedButton>
        </>}
        <Button variant="link" onClick={close} isDisabled={busy}>Close</Button>
        </div>
      </ModalFooter>
    </Modal>
  );
};
