import { ErrorDetails } from "./ErrorDetails";
import React, { useEffect, useId, useState } from "react";
import {
  Alert,
  Checkbox,
  CodeBlock,
  CodeBlockCode,
  Content,
  ContentVariants,
  Form,
  FormGroup,
  FormHelperText,
  FormSelect,
  FormSelectOption,
  HelperText,
  HelperTextItem,
  List,
  ListItem,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalVariant,
  Radio,
  TextInput,
} from "@patternfly/react-core";
import { CheckCircleIcon, ExclamationCircleIcon, TimesIcon } from "@patternfly/react-icons";
import type { KeyringKey, RepoEntry } from "../api";
import { useAnnounce } from "../contexts/AnnouncerContext";
import type { MutationGate } from "../hooks/useMutationGate";
import { plural, REPO_NAME_RE, sanitizeErrorMessage } from "../utils";
import type { AlertHeadingLevel } from "./ErrorAlert";
import { GatedButton } from "./GatedButton";
import { KeyFetchFields, LSIGN_CONSEQUENCE, isTrustedKey, keyName, useKeyImport } from "./ImportKeyModal";

export const SIG_LEVEL_OPTIONS = [
  { value: "", label: "Default" },
  { value: "Never", label: "Never" },
  { value: "Optional", label: "Optional" },
  { value: "Required", label: "Required" },
  { value: "Required DatabaseOptional", label: "Required DatabaseOptional" },
  { value: "TrustedOnly", label: "TrustedOnly" },
];

export function isInsecureSigLevel(value: string): boolean {
  return value
    .split(/\s+/)
    .some((token) => /^(?:Package)?(?:Never|TrustAll)$/.test(token));
}

export function directiveValueProblem(type: "Server" | "Include", value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (type === "Server" && !/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) {
    return "A Server needs a URL, such as https://mirror.example.org/$repo/os/$arch";
  }
  if (type === "Include" && !v.startsWith("/")) {
    return "An Include needs an absolute file path, such as /etc/pacman.d/mirrorlist";
  }
  return null;
}

// Match serialize_conf; save also preserves comments and unedited directives.
export function repoSectionText(repo: RepoEntry): string {
  const off = repo.enabled ? "" : "#";
  const lines = [`${off}[${repo.name}]`];
  if (repo.sig_level) lines.push(`${off}SigLevel = ${repo.sig_level}`);
  for (const d of repo.directives) {
    lines.push(`${off}${d.enabled ? "" : "#"}${d.directive_type} = ${d.value}`);
  }
  return lines.join("\n");
}

export const RESERVED_REPO_NAMES = new Set(["options", "local"]);

export function repoNameProblem(name: string, existing: string[]): string | null {
  if (!name) return null;
  if (name.length > 256) return "A repository name has at most 256 characters";
  if (!REPO_NAME_RE.test(name)) return "Use letters, digits, hyphens, underscores and periods only";
  if (RESERVED_REPO_NAMES.has(name)) return `[${name}] is reserved by pacman`;
  if (existing.includes(name)) return `[${name}] is already in pacman.conf`;
  return null;
}

interface InsecureSigLevelAckProps {
  id: string;
  sigLevel: string;
  /** Section the SigLevel applies to, such as "[extra]". */
  section: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** What still has to happen for the change to take effect. */
  note?: string;
  headingLevel?: AlertHeadingLevel;
}

export const InsecureSigLevelAck: React.FC<InsecureSigLevelAckProps> = ({ id, sigLevel, section, checked, onChange, note, headingLevel = "h4" }) => (
  <Alert component={headingLevel} variant="warning" isInline title="Disable signature verification?">
    <p>
      SigLevel = {sigLevel} lets pacman install packages from {section} without a
      verified, trusted signature.{note && ` ${note}`}
    </p>
    <Checkbox
      id={id}
      className="pf-v6-u-mt-sm"
      label={`Use ${sigLevel} for ${section} anyway`}
      isChecked={checked}
      onChange={(_event, value) => onChange(value)}
    />
  </Alert>
);

export const AlsoSavedChanges: React.FC<{ changes: string[] }> = ({ changes }) => {
  if (changes.length === 0) return null;
  return (
    <div>
      <Content component={ContentVariants.p}>
        This also saves your {plural(changes.length, "other change")}:
      </Content>
      <List aria-label="Other changes saved with this">
        {changes.map((change) => <ListItem key={change}>{change}</ListItem>)}
      </List>
    </div>
  );
};

const SOURCE_PROBLEM_DELAY_MS = 300;

type StepState = "pending" | "running" | "done" | "failed";

const StepItem: React.FC<{ state: StepState; children: React.ReactNode }> = ({ state, children }) => (
  <Content component={ContentVariants.li}>
    {state === "done" && <CheckCircleIcon color="var(--pf-t--global--icon--color--status--success--default)" />}
    {state === "failed" && <ExclamationCircleIcon color="var(--pf-t--global--icon--color--status--danger--default)" />}
    {" "}{children}
    <span className="pf-v6-screen-reader">
      {state === "done" ? ", done" : state === "running" ? ", in progress" : state === "failed" ? ", failed" : ", not started"}
    </span>
  </Content>
);

interface AddRepositoryModalProps {
  /** Every section name in pacman.conf, enabled or not. */
  existingNames: string[];
  /** The repository the new section is written after, or null for the end. */
  insertAfter: string | null;
  /** Other unsaved edits that the add saves along with it. */
  pendingChanges: string[];
  pendingBlockedReason?: string | null;
  /** Gate for writing pacman.conf. */
  gate: MutationGate;
  /** Gate for receiving and signing a key. */
  keyGate: MutationGate;
  onAdd: (entry: RepoEntry, signed: KeyringKey | null) => void;
  onClose: () => void;
}

export const AddRepositoryModal: React.FC<AddRepositoryModalProps> = ({
  existingNames,
  insertAfter,
  pendingChanges,
  pendingBlockedReason,
  gate,
  keyGate,
  onAdd,
  onClose,
}) => {
  const titleId = useId();
  const nameId = useId();
  const nameHelpId = useId();
  const sourceId = useId();
  const sourceHelpId = useId();
  const sigId = useId();
  const [name, setName] = useState("");
  const [sourceType, setSourceType] = useState<"Server" | "Include">("Server");
  const [source, setSource] = useState("");
  const [sigLevel, setSigLevel] = useState("");
  const [insecureAck, setInsecureAck] = useState(false);
  // A Server problem shows on blur or after a typing pause, not mid-URL.
  const [sourceSettled, setSourceSettled] = useState(true);
  const importer = useKeyImport();
  const announce = useAnnounce();
  const { key, signing, signError, fetching } = importer;
  const pendingCount = pendingChanges.length;
  const closeBlocked = fetching ? "Fetching cannot be interrupted" : signing ? "Signing cannot be interrupted" : null;

  useEffect(() => {
    if (sourceSettled) return;
    const timer = window.setTimeout(() => setSourceSettled(true), SOURCE_PROBLEM_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [source, sourceSettled]);

  const trimmedName = name.trim();
  const nameProblem = repoNameProblem(trimmedName, existingNames);
  const sourceProblem = directiveValueProblem(sourceType, source);
  const shownSourceProblem = sourceSettled ? sourceProblem : null;
  const insecure = isInsecureSigLevel(sigLevel);
  const needsSign = !!key && !isTrustedKey(key);
  const keyPending = importer.input.trim() !== "" && !key;

  const entry: RepoEntry = {
    name: trimmedName || "repo",
    enabled: true,
    sig_level: sigLevel || null,
    directives: source.trim() ? [{ directive_type: sourceType, value: source.trim(), enabled: true }] : [],
  };

  const blockedReason = !trimmedName
    ? "Enter a repository name"
    : nameProblem
      ?? (!source.trim() ? `Enter the ${sourceType === "Server" ? "Server URL" : "Include path"}` : null)
      ?? sourceProblem
      ?? (insecure && !insecureAck ? `Confirm SigLevel = ${sigLevel} first` : null)
      ?? (keyPending ? "Fetch the signing key first, or clear the fingerprint" : null)
      ?? pendingBlockedReason ?? null;

  const section = `[${trimmedName || "repository"}]`;
  const others = pendingCount > 0 ? ` and save ${plural(pendingCount, "other change")}` : "";
  const commitLabel = needsSign
    ? `Sign key${pendingCount > 0 ? "," : " and"} add ${section}${others}`
    : pendingCount > 0 ? `Add ${section}${others}` : `Add ${section} to pacman.conf`;

  const trustText = `${needsSign
    ? `${LSIGN_CONSEQUENCE} Undo removes ${section}; the key stays signed.`
    : "Add only repositories whose maintainers you trust. The previous pacman.conf is kept as a backup, and Undo restores it."} Nothing from ${section} can be found or installed until the next system upgrade downloads its package list.`;

  const signState: StepState = signing ? "running" : importer.signed ? "done" : signError ? "failed" : "pending";

  const handleCommit = async () => {
    if (blockedReason || gate.blocked) return;
    let signed: KeyringKey | null = null;
    if (needsSign) {
      signed = await importer.sign();
      if (!signed) return;
    }
    onAdd(entry, signed);
  };

  const close = () => {
    if (!closeBlocked) onClose();
  };

  return (
    <Modal
      variant={ModalVariant.medium}
      isOpen
      onEscapePress={() => (closeBlocked ? announce(closeBlocked) : close())}
      aria-labelledby={titleId}
    >
      {/* Stands in for Modal's own close button, which cannot be aria-disabled. */}
      <div className="pf-v6-c-modal-box__close">
        <GatedButton variant="plain" aria-label="Close" icon={<TimesIcon />} disabledReason={closeBlocked} onClick={close} />
      </div>
      <ModalHeader title="Add repository" labelId={titleId} />
      <ModalBody>
        <Form onSubmit={(event) => event.preventDefault()}>
          <FormGroup label="Name" isRequired fieldId={nameId}>
            <TextInput
              id={nameId}
              value={name}
              onChange={(_event, value) => setName(value)}
              validated={nameProblem ? "error" : "default"}
              aria-describedby={nameHelpId}
              placeholder="chaotic-aur"
              isRequired
              autoFocus
              isDisabled={signing}
            />
            <FormHelperText>
              <HelperText id={nameHelpId}>
                <HelperTextItem variant={nameProblem ? "error" : "default"}>
                  {nameProblem ?? "The section name the repository's packages and database use."}
                </HelperTextItem>
              </HelperText>
            </FormHelperText>
          </FormGroup>
          <FormGroup label="Source" isRequired role="radiogroup" fieldId={sourceId} isInline>
            <Radio
              id={`${sourceId}-server`}
              name={`${sourceId}-type`}
              label="Server URL"
              isChecked={sourceType === "Server"}
              onChange={() => setSourceType("Server")}
              isDisabled={signing}
            />
            <Radio
              id={`${sourceId}-include`}
              name={`${sourceId}-type`}
              label="Include file"
              isChecked={sourceType === "Include"}
              onChange={() => setSourceType("Include")}
              isDisabled={signing}
            />
          </FormGroup>
          <FormGroup label={sourceType === "Server" ? "Server" : "Include"} isRequired fieldId={sourceId}>
            <TextInput
              id={sourceId}
              value={source}
              onChange={(_event, value) => {
                setSource(value);
                setSourceSettled(false);
              }}
              onBlur={() => setSourceSettled(true)}
              validated={shownSourceProblem ? "error" : "default"}
              aria-describedby={sourceHelpId}
              placeholder={sourceType === "Server" ? "https://repo.example.org/$repo/$arch" : "/etc/pacman.d/chaotic-mirrorlist"}
              isRequired
              isDisabled={signing}
            />
            <FormHelperText>
              <HelperText id={sourceHelpId}>
                <HelperTextItem variant={shownSourceProblem ? "error" : "default"}>
                  {shownSourceProblem ?? (sourceType === "Server"
                    ? "pacman replaces $repo and $arch in the URL."
                    : "A mirrorlist file of Server lines, usually installed by the repository's mirrorlist package.")}
                </HelperTextItem>
              </HelperText>
            </FormHelperText>
          </FormGroup>
          <FormGroup label="SigLevel" fieldId={sigId}>
            <FormSelect
              id={sigId}
              value={sigLevel}
              onChange={(_event, value) => {
                setSigLevel(value);
                setInsecureAck(false);
              }}
              isDisabled={signing}
            >
              {SIG_LEVEL_OPTIONS.map((opt) => (
                <FormSelectOption
                  key={opt.value}
                  value={opt.value}
                  label={opt.value === "" ? "Default (the SigLevel in [options])" : opt.label}
                />
              ))}
            </FormSelect>
          </FormGroup>
          {insecure && (
            <InsecureSigLevelAck
              headingLevel="h2"
              id={`${sigId}-ack`}
              sigLevel={sigLevel}
              section={section}
              checked={insecureAck}
              onChange={setInsecureAck}
            />
          )}
          <KeyFetchFields importer={importer} label="Signing key fingerprint (optional)" gate={keyGate} disabled={signing} />
          {key && isTrustedKey(key) && (
            <HelperText>
              <HelperTextItem variant="success">{keyName(key)} is already trusted; nothing needs to be signed.</HelperTextItem>
            </HelperText>
          )}
          {needsSign && (
            <Content component={ContentVariants.p}>
              Compare this fingerprint with the one {section} publishes before signing. The user ID
              comes from the keyserver and proves nothing about who holds the key.
            </Content>
          )}
          <div>
            <Content component={ContentVariants.p}>
              Written to /etc/pacman.conf {insertAfter ? `after [${insertAfter}]` : "at the end"}:
            </Content>
            <CodeBlock>
              <CodeBlockCode>{repoSectionText({ ...entry, name: trimmedName || "repository" })}</CodeBlockCode>
            </CodeBlock>
          </div>
          {insecure ? (
            <Alert component="h2" variant="danger" isInline isPlain title="Packages from this repository will be trusted for installs and upgrades">
              {trustText}
            </Alert>
          ) : (
            <Content component={ContentVariants.p}>
              Packages from this repository will be trusted for installs and upgrades. {trustText}
            </Content>
          )}
          <AlsoSavedChanges changes={pendingChanges} />
          {needsSign && (signing || importer.signed || signError) && (
            <Content component={ContentVariants.ul} isPlainList aria-label="Steps">
              <StepItem state="done">Fetch key for {keyName(key)}</StepItem>
              <StepItem state={signState}>Sign key locally</StepItem>
              <StepItem state="pending">Add {section} to pacman.conf</StepItem>
            </Content>
          )}
          {signError && (
            <Alert component="h2" variant="danger" isInline isPlain title="Key not signed; the repository was not added">
              {sanitizeErrorMessage(signError)}
              <ErrorDetails details={importer.signErrorDetails} />
            </Alert>
          )}
        </Form>
      </ModalBody>
      <ModalFooter>
        <GatedButton
          variant={insecure ? "danger" : "primary"}
          gate={needsSign && keyGate.blocked ? keyGate : gate}
          disabledReason={blockedReason}
          onClick={handleCommit}
          isLoading={signing}
        >
          {commitLabel}
        </GatedButton>
        <GatedButton variant="link" disabledReason={closeBlocked} onClick={close}>Cancel</GatedButton>
      </ModalFooter>
    </Modal>
  );
};
