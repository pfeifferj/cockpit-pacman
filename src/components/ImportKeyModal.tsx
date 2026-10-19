import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  Alert,
  Button,
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  ExpandableSection,
  Flex,
  FlexItem,
  FormGroup,
  FormHelperText,
  HelperText,
  HelperTextItem,
  Label,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalVariant,
  TextInput,
} from "@patternfly/react-core";
import { TimesIcon } from "@patternfly/react-icons";
import { BackendError, type KeyringKey, RECEIVE_KEY_BACKEND_TIMEOUT_S, lsignKey, normalizeFingerprint, receiveKey } from "../api";
import { useAnnounce } from "../contexts/AnnouncerContext";
import type { MutationGate } from "../hooks/useMutationGate";
import { sanitizeErrorMessage } from "../utils";
import { ErrorDetails } from "./ErrorDetails";
import { GatedButton } from "./GatedButton";

/** "ABCD1234..." as "ABCD 1234 ...", the grouping gpg prints. */
export function formatFingerprint(fingerprint: string): string {
  return fingerprint.replace(/(.{4})(?=.)/g, "$1 ");
}

/** Trust levels under which pacman already accepts the key's signatures. */
export function isTrustedKey(key: KeyringKey): boolean {
  return key.trust === "full" || key.trust === "ultimate";
}

function fingerprintProblem(input: string): string | null {
  const compact = input.replace(/\s+/g, "").replace(/^0x/i, "");
  if (!compact || normalizeFingerprint(input)) return null;
  if (/^[0-9a-f]+$/i.test(compact) && (compact.length === 8 || compact.length === 16)) {
    return "This is a key id. Enter the full 40-character fingerprint, since a key id can match a different key.";
  }
  return "A fingerprint is 40 hexadecimal characters, such as 3B94 A80E 50A4 77C7 C8E4 4F8A 0FA8 E1BC B1F1 A2C0.";
}

const KEYSERVER_SCHEMES = ["hkps://", "hkp://", "https://", "http://", "ldap://"];

function keyserverProblem(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (KEYSERVER_SCHEMES.includes(`${url.protocol}//`) && url.hostname && !url.username && !url.password && value.length <= 512 && !/\s/.test(value) && !Array.from(value).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return null;
  } catch { /* Invalid URLs are reported below. */ }
  return "A keyserver address starts with hkps://, hkp://, https://, http:// or ldap://, such as hkps://keyserver.ubuntu.com.";
}

/** Fetch-then-sign state for one fingerprint, shared by Add key and Add repository. */
export function useKeyImport() {
  const [input, setInputState] = useState("");
  const [fetched, setFetched] = useState<KeyringKey | null>(null);
  const [keyserver, setKeyserver] = useState("");
  const [fetching, setFetching] = useState(false);
  const [fetchStartedAt, setFetchStartedAt] = useState<number | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [fetchErrorDetails, setFetchErrorDetails] = useState<string | undefined>();
  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);
  const [signErrorDetails, setSignErrorDetails] = useState<string | undefined>();
  const [signed, setSigned] = useState<KeyringKey | null>(null);
  const requestRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => {
    requestRef.current++;
    controllerRef.current?.abort();
  }, []);

  const fingerprint = normalizeFingerprint(input);
  const key = fetched && fingerprint && fetched.fingerprint.toUpperCase() === fingerprint ? fetched : null;

  const setInput = useCallback((value: string) => {
    if (controllerRef.current) return;
    setInputState(value);
    setFetchError(null);
    setSignError(null);
    requestRef.current++;
    setFetching(false);
  }, []);

  const fetch = async () => {
    if (!fingerprint || controllerRef.current || keyserverProblem(keyserver)) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    const request = ++requestRef.current;
    setFetching(true);
    setFetchStartedAt(Date.now());
    setFetchError(null);
    setFetchErrorDetails(undefined);
    setSignError(null);
    const server = keyserver.trim();
    try {
      const result = await receiveKey(fingerprint, server || undefined, controller.signal);
      if (result.key.fingerprint.toUpperCase() !== fingerprint) throw new Error("The keyserver returned a different fingerprint.");
      if (request !== requestRef.current) return;
      setFetched(result.key);
    } catch (ex) {
      if (request !== requestRef.current) return;
      setFetchError(ex instanceof Error ? ex.message : String(ex));
      setFetchErrorDetails(ex instanceof BackendError ? ex.details : undefined);
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      if (request === requestRef.current) setFetching(false);
    }
  };

  const sign = async (): Promise<KeyringKey | null> => {
    if (!key || controllerRef.current) return null;
    const request = ++requestRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    setSigning(true);
    setSignError(null);
    setSignErrorDetails(undefined);
    try {
      const result = await lsignKey(key.fingerprint, controller.signal);
      if (request !== requestRef.current) return null;
      if (result.key.fingerprint.toUpperCase() !== key.fingerprint.toUpperCase()) throw new Error("The signed key has a different fingerprint.");
      setSigned(result.key);
      setFetched(result.key);
      return result.key;
    } catch (ex) {
      if (request !== requestRef.current) return null;
      setSignError(ex instanceof Error ? ex.message : String(ex));
      setSignErrorDetails(ex instanceof BackendError ? ex.details : undefined);
      return null;
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      if (request === requestRef.current) setSigning(false);
    }
  };

  return {
    input,
    setInput,
    fingerprint,
    problem: fingerprintProblem(input),
    keyserver,
    setKeyserver,
    keyserverProblem: keyserverProblem(keyserver),
    key,
    /** The last key received, even if the fingerprint field has changed since. */
    fetched,
    fetching,
    fetchStartedAt,
    fetchError,
    fetchErrorDetails,
    fetch,
    signing,
    signError,
    signErrorDetails,
    signed,
    sign,
  };
}

export type KeyImport = ReturnType<typeof useKeyImport>;

export function keyName(key: KeyringKey): string {
  return key.uid || formatFingerprint(key.fingerprint);
}

interface KeyFetchFieldsProps {
  importer: KeyImport;
  label: string;
  /** Gate for receiving the key, which changes the pacman keyring. */
  gate: MutationGate;
  autoFocus?: boolean;
  disabled?: boolean;
}

export const KeyFetchFields: React.FC<KeyFetchFieldsProps> = ({ importer, label, gate, autoFocus, disabled }) => {
  const inputId = useId();
  const helpId = useId();
  const keyserverId = useId();
  const keyserverHelpId = useId();
  const [keyserverOpen, setKeyserverOpen] = useState(false);
  const {
    input, setInput, fingerprint, problem, keyserver, setKeyserver, keyserverProblem: serverProblem,
    key, fetching, fetchStartedAt, fetchError, fetch,
  } = importer;
  const fetchBlocked = !fingerprint
    ? "Enter a 40-character fingerprint"
    : key ? "This key is fetched"
    : serverProblem ? "Enter a valid keyserver address" : null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!fetching) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [fetching]);
  const elapsed = fetchStartedAt === null ? 0 : Math.max(0, Math.floor((now - fetchStartedAt) / 1000));
  const server = keyserver.trim() || "the keyring's configured keyserver";
  return (
    <>
      <FormGroup label={label} fieldId={inputId}>
        <Flex spaceItems={{ default: "spaceItemsSm" }} flexWrap={{ default: "nowrap" }}>
          <FlexItem grow={{ default: "grow" }}>
            <TextInput
              id={inputId}
              value={input}
              onChange={(_event, value) => setInput(value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (!fetchBlocked && !gate.blocked) fetch();
                }
              }}
              validated={problem ? "error" : "default"}
              aria-describedby={helpId}
              placeholder="3B94 A80E 50A4 77C7 C8E4 4F8A 0FA8 E1BC B1F1 A2C0"
              autoFocus={autoFocus}
              isDisabled={disabled}
              readOnlyVariant={fetching ? "default" : undefined}
              spellCheck={false}
            />
          </FlexItem>
          <FlexItem>
            <GatedButton
              variant="secondary"
              gate={gate}
              disabledReason={disabled ? "Signing is under way" : fetchBlocked}
              onClick={fetch}
              isLoading={fetching}
            >
              {fetching ? "Fetching…" : "Fetch"}
            </GatedButton>
          </FlexItem>
        </Flex>
        <FormHelperText>
          <HelperText id={helpId}>
            {fetching ? (
              <HelperTextItem>
                Fetching the key from {server}: {elapsed} s, up to {RECEIVE_KEY_BACKEND_TIMEOUT_S} s.
              </HelperTextItem>
            ) : (
              <HelperTextItem variant={problem ? "error" : "default"}>
                {problem ?? "Fetching adds the key to the pacman keyring without trusting it."}
              </HelperTextItem>
            )}
          </HelperText>
        </FormHelperText>
      </FormGroup>
      <ExpandableSection
        toggleText="Keyserver"
        isExpanded={keyserverOpen || !!serverProblem}
        onToggle={(_event, expanded) => setKeyserverOpen(expanded)}
        className="pf-v6-u-mt-sm"
      >
        <FormGroup label="Keyserver (optional)" fieldId={keyserverId}>
          <TextInput
            id={keyserverId}
            value={keyserver}
            onChange={(_event, value) => setKeyserver(value)}
            validated={serverProblem ? "error" : "default"}
            aria-describedby={keyserverHelpId}
            placeholder="hkps://keyserver.ubuntu.com"
            isDisabled={disabled}
            readOnlyVariant={fetching ? "default" : undefined}
            spellCheck={false}
          />
          <FormHelperText>
            <HelperText id={keyserverHelpId}>
              <HelperTextItem variant={serverProblem ? "error" : "default"}>
                {serverProblem ?? "Leave empty to use the keyring's configured keyserver."}
              </HelperTextItem>
            </HelperText>
          </FormHelperText>
        </FormGroup>
      </ExpandableSection>
      {fetchError && (
        <Alert component="h2" variant="danger" isInline isPlain title="Key not fetched">
          {sanitizeErrorMessage(fetchError)}
          <ErrorDetails details={importer.fetchErrorDetails} />
        </Alert>
      )}
      {key && (
        <div role="group" aria-label="Fetched key">
          <DescriptionList isCompact isHorizontal>
            <DescriptionListGroup>
              <DescriptionListTerm>User ID</DescriptionListTerm>
              <DescriptionListDescription>{key.uid || "None"}</DescriptionListDescription>
            </DescriptionListGroup>
            <DescriptionListGroup>
              <DescriptionListTerm>Fingerprint</DescriptionListTerm>
              <DescriptionListDescription><code>{formatFingerprint(key.fingerprint)}</code></DescriptionListDescription>
            </DescriptionListGroup>
            <DescriptionListGroup>
              <DescriptionListTerm>Trust</DescriptionListTerm>
              <DescriptionListDescription>
                <Label isCompact color={isTrustedKey(key) ? "green" : "grey"}>{key.trust}</Label>
              </DescriptionListDescription>
            </DescriptionListGroup>
          </DescriptionList>
        </div>
      )}
    </>
  );
};

export const LSIGN_CONSEQUENCE =
  "A locally signed key is trusted for every repository: pacman accepts any package it signs, whichever repository the package comes from. Signing cannot be undone from this page.";

interface ImportKeyModalProps {
  /** `added` is a received key left untrusted, so the caller can say so. */
  onClose: (added: KeyringKey | null) => void;
  onSigned: (key: KeyringKey) => void;
  gate: MutationGate;
}

export const ImportKeyModal: React.FC<ImportKeyModalProps> = ({ onClose, onSigned, gate }) => {
  const titleId = useId();
  const importer = useKeyImport();
  const announce = useAnnounce();
  const { key, fetched, fetching, signing, signError } = importer;
  const trusted = key ? isTrustedKey(key) : false;
  const closeBlocked = fetching ? "Fetching cannot be interrupted" : signing ? "Signing cannot be interrupted" : null;

  const handleSign = async () => {
    if (gate.blocked) return;
    const signedKey = await importer.sign();
    if (signedKey) onSigned(signedKey);
  };

  const close = () => {
    if (closeBlocked) return;
    onClose(fetched && !isTrustedKey(fetched) ? fetched : null);
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
      <ModalHeader title="Add key" labelId={titleId} />
      <ModalBody>
        <KeyFetchFields importer={importer} label="Key fingerprint" gate={gate} autoFocus disabled={signing} />
        {key && trusted && (
          <Alert component="h2" variant="info" isInline isPlain title="This key is already trusted" className="pf-v6-u-mt-md">
            pacman accepts packages signed by {keyName(key)}. Nothing needs to be signed.
          </Alert>
        )}
        {key && !trusted && (
          <Alert component="h2" variant="warning" isInline isPlain title={`Locally sign key for ${keyName(key)}?`} className="pf-v6-u-mt-md">
            {LSIGN_CONSEQUENCE}
          </Alert>
        )}
        {signError && (
          <Alert component="h2" variant="danger" isInline isPlain title="Key not signed" className="pf-v6-u-mt-md">
            {sanitizeErrorMessage(signError)}
            <ErrorDetails details={importer.signErrorDetails} />
          </Alert>
        )}
      </ModalBody>
      <ModalFooter>
        {key && trusted ? (
          <Button variant="primary" onClick={close}>Close</Button>
        ) : (
          <>
            <GatedButton
              variant="primary"
              gate={gate}
              disabledReason={!key && "Fetch the key first"}
              onClick={handleSign}
              isLoading={signing}
            >
              {key ? `Locally sign key for ${keyName(key)}` : "Locally sign key"}
            </GatedButton>
            <GatedButton variant="link" disabledReason={closeBlocked} onClick={close}>Cancel</GatedButton>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
};
