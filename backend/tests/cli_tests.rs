use std::process::{Command, Output};

const BIN: &str = env!("CARGO_BIN_EXE_cockpit-pacman-backend");

fn run(args: &[&str]) -> Output {
    Command::new(BIN)
        .args(args)
        .output()
        .expect("the backend binary builds and runs")
}

fn stdout_of(output: &Output) -> String {
    String::from_utf8(output.stdout.clone()).expect("stdout is utf-8")
}

fn expect_error_envelope(args: &[&str]) -> serde_json::Value {
    let output = run(args);
    let stdout = stdout_of(&output);

    assert_eq!(
        output.status.code(),
        Some(0),
        "a frontend command reports failure in the envelope, not the exit code: {args:?} gave {stdout}"
    );
    assert_eq!(
        stdout.trim().lines().count(),
        1,
        "the envelope is exactly one line: {stdout}"
    );

    let envelope: serde_json::Value = serde_json::from_str(stdout.trim())
        .unwrap_or_else(|e| panic!("stdout is JSON: {e}: {stdout}"));
    assert!(
        envelope.get("code").and_then(|c| c.as_str()).is_some(),
        "envelope carries a code: {envelope}"
    );
    assert!(
        !envelope["message"].as_str().unwrap_or_default().is_empty(),
        "envelope carries a message: {envelope}"
    );
    envelope
}

#[test]
fn an_unknown_command_exits_non_zero_and_says_so() {
    let output = run(&["not-a-real-command"]);
    let stderr = String::from_utf8(output.stderr.clone()).expect("stderr is utf-8");

    assert_eq!(output.status.code(), Some(1));
    assert!(stderr.contains("unknown command"), "{stderr}");
    assert!(
        stdout_of(&output).is_empty(),
        "nothing goes to stdout, which is the data channel"
    );
}

#[test]
fn no_command_at_all_exits_non_zero() {
    let output = run(&[]);
    assert_eq!(output.status.code(), Some(1));
}

#[test]
fn a_missing_required_argument_exits_non_zero() {
    for args in [
        vec!["security-info"],
        vec!["local-package-info"],
        vec!["downgrade-archive", "linux"],
    ] {
        let output = run(&args);
        assert_eq!(
            output.status.code(),
            Some(1),
            "{args:?} should refuse to run without its arguments"
        );
    }
}

#[test]
fn a_bool_argument_that_is_neither_true_nor_false_is_refused() {
    for args in [vec!["set-settings", "yes"], vec!["check-security", "1"]] {
        let output = run(&args);
        assert_eq!(
            output.status.code(),
            Some(1),
            "{args:?} must not be treated as unset or false"
        );
    }
}

#[test]
fn pagination_beyond_the_limit_is_refused_before_the_database_is_opened() {
    let envelope = expect_error_envelope(&["list-installed", "0", "2000"]);
    assert!(
        envelope["message"]
            .as_str()
            .unwrap_or_default()
            .contains("Limit"),
        "{envelope}"
    );
}

#[test]
fn a_depth_outside_the_range_is_refused() {
    let envelope = expect_error_envelope(&["dependency-tree", "linux", "99", "forward"]);
    assert!(
        envelope["message"]
            .as_str()
            .unwrap_or_default()
            .contains("Depth"),
        "{envelope}"
    );
}

#[test]
fn an_archive_filename_that_escapes_its_directory_is_refused() {
    for filename in [
        "../evil.pkg.tar.zst",
        "sub/dir.pkg.tar.zst",
        "linux-1.0-1-x86_64.tar.gz",
    ] {
        let envelope = expect_error_envelope(&["downgrade-archive", "linux", filename]);
        assert_eq!(
            envelope["code"], "internal_error",
            "{filename} rejected with an unexpected code: {envelope}"
        );
    }
}

#[test]
fn an_archive_filename_for_a_different_package_is_refused() {
    expect_error_envelope(&[
        "downgrade-archive",
        "linux",
        "bash-5.2-1-x86_64.pkg.tar.zst",
    ]);
}

#[test]
fn an_empty_search_query_is_refused() {
    expect_error_envelope(&["search", ""]);
}

#[test]
fn an_invalid_package_name_is_refused() {
    for name in ["../etc/passwd", "linux;reboot", ""] {
        expect_error_envelope(&["local-package-info", name]);
    }
}
