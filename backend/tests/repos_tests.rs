//! Failing tests for the repos parser/serializer.
//!
//! These tests import from cockpit_pacman_backend::handlers::repos, which does not
//! exist yet. They will produce an 'unresolved import' compile error until the
//! implementation is added.
//!
//! Run with: cargo test --test repos_tests

use cockpit_pacman_backend::handlers::repos::{
    Directive, DirectiveKind, PacmanConf, parse_conf, serialize_conf,
};

const FIXTURE: &str = r#"[options]
HoldPkg     = pacman glibc
Architecture = auto

[core]
SigLevel = Required DatabaseOptional
Include = /etc/pacman.d/mirrorlist

[extra]
SigLevel = Required DatabaseOptional
Server = https://geo.mirror.pkgbuild.com/$repo/os/$arch
"#;

#[test]
fn round_trip_with_no_mutations_produces_identical_output() {
    let parsed: PacmanConf = parse_conf(FIXTURE);
    let output = serialize_conf(&parsed);
    assert_eq!(output, FIXTURE);
}

#[test]
fn disabling_repo_comments_out_section_header_and_directives() {
    let mut parsed: PacmanConf = parse_conf(FIXTURE);
    parsed.repos[0].enabled = false;
    let output = serialize_conf(&parsed);
    assert!(
        output.contains("#[core]"),
        "disabled section header must be commented out"
    );
    let core_part = output.split("[extra]").next().unwrap();
    assert!(
        core_part.contains("#SigLevel") || core_part.contains("# SigLevel"),
        "disabled section directives must be commented out"
    );
    assert!(
        core_part.contains("#Include") || core_part.contains("# Include"),
        "disabled Include directive must be commented out"
    );
}

#[test]
fn reordering_repos_swaps_their_order_in_serialized_output() {
    let mut parsed: PacmanConf = parse_conf(FIXTURE);
    parsed.repos.swap(0, 1);
    let output = serialize_conf(&parsed);
    let extra_pos = output
        .find("[extra]")
        .expect("[extra] must appear in output");
    let core_pos = output.find("[core]").expect("[core] must appear in output");
    assert!(
        extra_pos < core_pos,
        "[extra] must appear before [core] after swap"
    );
}

#[test]
fn changing_siglevel_updates_only_that_field() {
    let mut parsed: PacmanConf = parse_conf(FIXTURE);
    parsed.repos[0].sig_level = Some("TrustedOnly".to_string());
    let output = serialize_conf(&parsed);
    let core_part = output.split("[extra]").next().unwrap();
    assert!(
        core_part.contains("SigLevel = TrustedOnly"),
        "updated SigLevel must appear in core section"
    );
    assert!(
        !core_part.contains("SigLevel = Required DatabaseOptional"),
        "old SigLevel must not remain in core section"
    );
    let extra_part = output.split("[extra]").nth(1).unwrap();
    assert!(
        extra_part.contains("SigLevel = Required DatabaseOptional"),
        "extra SigLevel must remain unchanged"
    );
}

#[test]
fn adding_server_directive_appends_in_correct_section() {
    let mut parsed: PacmanConf = parse_conf(FIXTURE);
    let new_directive = Directive {
        kind: DirectiveKind::Server,
        value: "https://mirror.rackspace.com/archlinux/$repo/os/$arch".to_string(),
        enabled: true,
    };
    parsed.repos[0].directives.push(new_directive);
    let output = serialize_conf(&parsed);
    let core_part = output.split("[extra]").next().unwrap();
    assert!(
        core_part.contains("Server = https://mirror.rackspace.com/archlinux/$repo/os/$arch"),
        "new Server directive must appear in core section"
    );
}

#[test]
fn removing_directive_omits_it_from_serialized_output() {
    let mut parsed: PacmanConf = parse_conf(FIXTURE);
    // Remove the Include directive from core (index 0 in its directives list)
    parsed.repos[0].directives.remove(0);
    let output = serialize_conf(&parsed);
    // Only core had Include; extra has Server. Removing core's Include means
    // Include should not appear anywhere in the output.
    assert!(
        !output.contains("Include = /etc/pacman.d/mirrorlist"),
        "removed directive must not appear in serialized output"
    );
}
