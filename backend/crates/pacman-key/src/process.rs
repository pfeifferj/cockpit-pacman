use std::io;
use std::process::{Output, Stdio};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, Command};
use tokio::time::Instant;

use crate::{CancellationToken, Error, OperationOptions, Result};

pub(crate) const OUTPUT_LIMIT: usize = 1024 * 1024;

pub(crate) struct Operation {
    deadline: Option<Instant>,
    timeout_secs: u64,
    cancel: Option<CancellationToken>,
}

impl Operation {
    pub(crate) fn new(options: OperationOptions) -> Self {
        let timeout_secs = options.timeout_secs.filter(|seconds| *seconds > 0);
        Self {
            deadline: timeout_secs.map(|seconds| Instant::now() + Duration::from_secs(seconds)),
            timeout_secs: timeout_secs.unwrap_or(0),
            cancel: options.cancel_token,
        }
    }

    pub(crate) async fn wait<F: Future>(&self, future: F) -> Result<F::Output> {
        let timeout = async {
            match self.deadline {
                Some(deadline) => tokio::time::sleep_until(deadline).await,
                None => std::future::pending().await,
            }
        };
        let cancel = async {
            match &self.cancel {
                Some(cancel) => cancel.cancelled().await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            biased;
            _ = cancel => Err(Error::Cancelled),
            _ = timeout => Err(Error::Timeout(self.timeout_secs)),
            result = future => Ok(result),
        }
    }
}

pub(crate) struct ProcessGroup {
    pub(crate) child: Child,
    group: Option<libc::pid_t>,
}

impl ProcessGroup {
    pub(crate) fn spawn(command: &mut Command) -> io::Result<Self> {
        let child = command.process_group(0).kill_on_drop(true).spawn()?;
        let group = child.id().map(|id| id as libc::pid_t);
        Ok(Self { child, group })
    }

    fn kill(&mut self) {
        if let Some(group) = self.group.take() {
            // The child owns this group; the backend never joins it.
            unsafe { libc::kill(-group, libc::SIGKILL) };
        }
        let _ = self.child.start_kill();
    }

    pub(crate) async fn terminate(&mut self) {
        self.kill();
        let _ = tokio::time::timeout(Duration::from_secs(2), self.child.wait()).await;
    }

    pub(crate) fn completed(&mut self) {
        self.group = None;
    }
}

impl Drop for ProcessGroup {
    fn drop(&mut self) {
        if self.group.is_some() {
            self.kill();
        }
    }
}

async fn collect(mut reader: impl AsyncRead + Unpin, limit: Option<usize>) -> io::Result<Vec<u8>> {
    let mut output = Vec::new();
    let mut buffer = [0; 8192];
    let mut truncated = false;
    loop {
        let length = reader.read(&mut buffer).await?;
        if length == 0 {
            break;
        }
        let retained = length.min(limit.unwrap_or(usize::MAX).saturating_sub(output.len()));
        output.extend_from_slice(&buffer[..retained]);
        truncated |= retained != length;
    }
    if truncated {
        output.extend_from_slice(b"\n[output truncated]\n");
    }
    Ok(output)
}

pub(crate) async fn output(command: &mut Command, operation: &Operation) -> Result<Output> {
    operation.wait(std::future::ready(())).await?;
    let mut process = ProcessGroup::spawn(command.stdout(Stdio::piped()).stderr(Stdio::piped()))?;
    let stdout = process.child.stdout.take().expect("stdout is piped");
    let stderr = process.child.stderr.take().expect("stderr is piped");
    let result = operation
        .wait(async {
            tokio::try_join!(
                process.child.wait(),
                collect(stdout, None),
                collect(stderr, Some(OUTPUT_LIMIT))
            )
        })
        .await
        .and_then(|result| result.map_err(Error::Command));
    match result {
        Ok((status, stdout, stderr)) => {
            process.completed();
            Ok(Output {
                status,
                stdout,
                stderr,
            })
        }
        Err(error) => {
            process.terminate().await;
            Err(error)
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    pub(crate) struct Fixture {
        directory: tempfile::TempDir,
    }

    impl Fixture {
        pub(crate) fn new() -> Self {
            Self {
                directory: tempfile::tempdir().unwrap(),
            }
        }

        pub(crate) fn path(&self, name: &str) -> PathBuf {
            self.directory.path().join(name)
        }

        pub(crate) fn command(&self, script: &str) -> Command {
            let mut command = Command::new("/bin/sh");
            command
                .args(["-c", script, "keyring-fixture"])
                .arg(self.directory.path());
            command
        }

        pub(crate) async fn stopped(&self) {
            for name in ["parent", "grandchild"] {
                let path = self.path(name);
                if path.exists() {
                    let pid = std::fs::read_to_string(path).unwrap();
                    let stat = Path::new("/proc").join(pid.trim()).join("stat");
                    tokio::time::timeout(Duration::from_secs(5), async {
                        loop {
                            match std::fs::read_to_string(&stat) {
                                Ok(text)
                                    if text
                                        .rsplit_once(") ")
                                        .is_some_and(|(_, rest)| !rest.starts_with('Z')) => {}
                                _ => break,
                            }
                            tokio::time::sleep(Duration::from_millis(10)).await;
                        }
                    })
                    .await
                    .expect("fixture process survived cleanup");
                }
            }
            assert!(
                std::process::Command::new("flock")
                    .arg("-n")
                    .arg(self.path("lock"))
                    .arg("true")
                    .status()
                    .unwrap()
                    .success()
            );
        }
    }

    pub(crate) async fn ready(path: &Path) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while !path.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("fixture process did not become ready");
    }

    const HUNG_GROUP: &str = r#"
echo $$ > "$1/parent"
flock "$1/lock" sh -c 'echo $$ > "$1/grandchild"; touch "$1/ready"; exec sleep 60' keyring-grandchild "$1" &
wait
"#;

    #[tokio::test]
    async fn timeout_kills_a_child_and_grandchild_holding_stderr_and_a_lock() {
        let fixture = Fixture::new();
        let operation = Operation::new(OperationOptions {
            timeout_secs: Some(1),
            cancel_token: None,
        });
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            output(&mut fixture.command(HUNG_GROUP), &operation),
        )
        .await
        .unwrap();
        assert!(matches!(result, Err(Error::Timeout(1))));
        fixture.stopped().await;
    }

    #[tokio::test]
    async fn timeout_covers_stderr_held_open_after_the_parent_exits() {
        let fixture = Fixture::new();
        let script = HUNG_GROUP.replace("\nwait\n", "\nexit 0\n");
        let operation = Operation::new(OperationOptions {
            timeout_secs: Some(1),
            cancel_token: None,
        });
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            output(&mut fixture.command(&script), &operation),
        )
        .await
        .unwrap();
        assert!(matches!(result, Err(Error::Timeout(1))));
        fixture.stopped().await;
    }

    #[tokio::test]
    async fn cancellation_releases_the_process_group_lock() {
        let fixture = Fixture::new();
        let cancel = CancellationToken::new();
        let operation = Operation::new(OperationOptions {
            timeout_secs: None,
            cancel_token: Some(cancel.clone()),
        });
        let mut command = fixture.command(HUNG_GROUP);
        let task = tokio::spawn(async move { output(&mut command, &operation).await });
        ready(&fixture.path("ready")).await;
        cancel.cancel();
        assert!(matches!(task.await.unwrap(), Err(Error::Cancelled)));
        fixture.stopped().await;
    }

    #[tokio::test]
    async fn dropping_the_operation_kills_its_process_group() {
        let fixture = Fixture::new();
        let operation = Operation::new(OperationOptions::default());
        let mut command = fixture.command(HUNG_GROUP);
        let task = tokio::spawn(async move { output(&mut command, &operation).await });
        ready(&fixture.path("ready")).await;
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        fixture.stopped().await;
    }

    #[tokio::test]
    async fn stderr_is_drained_with_bounded_retained_output() {
        let fixture = Fixture::new();
        let operation = Operation::new(OperationOptions {
            timeout_secs: Some(5),
            cancel_token: None,
        });
        let result = output(
            &mut fixture.command("head -c 2097152 /dev/zero >&2"),
            &operation,
        )
        .await
        .unwrap();
        assert!(result.status.success());
        assert!(result.stderr.len() >= OUTPUT_LIMIT);
        assert!(result.stderr.len() < OUTPUT_LIMIT + 64);
    }

    #[tokio::test]
    async fn successful_command_output_is_not_truncated() {
        let fixture = Fixture::new();
        let operation = Operation::new(OperationOptions::default());
        let result = output(
            &mut fixture.command("head -c 2097152 /dev/zero"),
            &operation,
        )
        .await
        .unwrap();
        assert!(result.status.success());
        assert_eq!(result.stdout.len(), 2097152);
    }

    #[tokio::test]
    async fn a_cancelled_operation_does_not_start_a_child() {
        let fixture = Fixture::new();
        let cancel = CancellationToken::new();
        cancel.cancel();
        let operation = Operation::new(OperationOptions {
            timeout_secs: None,
            cancel_token: Some(cancel),
        });
        let result = output(&mut fixture.command("touch \"$1/started\""), &operation).await;
        assert!(matches!(result, Err(Error::Cancelled)));
        assert!(!fixture.path("started").exists());
    }
}
