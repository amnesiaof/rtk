//! OpenCode plugin: install/uninstall helpers.
use super::*;
use crate::hooks::constants::{CONFIG_DIR, OPENCODE_PLUGIN_FILE, OPENCODE_SUBDIR, PLUGIN_SUBDIR};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};

// Embedded OpenCode plugin (auto-rewrite)
const OPENCODE_PLUGIN: &str = include_str!("../../../hooks/opencode/rtk.ts");

// Embedded OpenCode plugin for OpenCode <= 1.3.3.
//
// Those loaders call every export as `fn(input)`, which the object rtk.ts
// default-exports is not: 1.1.4 exits 1 at startup and 1.3.3 logs "failed to
// load plugin". The 2.x loader is the mirror image and rejects a callable
// default, so the two cannot be one file. `rtk init -g --opencode` picks by
// `opencode --version`; `--opencode-legacy` forces this one.
const OPENCODE_PLUGIN_LEGACY: &str = include_str!("../../../hooks/opencode/rtk-legacy.ts");

/// Set by `rtk init --opencode-legacy`, before any install runs.
///
/// A global rather than an extra parameter on `ensure_opencode_plugin_installed`:
/// that function is called from four sites in three modes, none of which
/// otherwise know about OpenCode versions.
static LEGACY_OVERRIDE: AtomicBool = AtomicBool::new(false);

pub(crate) fn set_opencode_legacy_override(legacy: bool) {
    LEGACY_OVERRIDE.store(legacy, Ordering::Relaxed);
}

/// Does this OpenCode version need the legacy plugin?
///
/// 1.3.4 is the floor: it is the first loader that reads a plugin's hooks off a
/// default export instead of calling it. Anything we cannot parse — no OpenCode
/// installed, an unknown banner — gets the current plugin, which is the one
/// that works on every currently released version.
fn needs_legacy_plugin(version_out: &str) -> bool {
    let Some((major, minor, patch)) = parse_version(version_out) else {
        return false;
    };
    if major == 0 {
        return true;
    }
    major == 1 && (minor, patch) < (3, 4)
}

/// Pull `major.minor.patch` out of `opencode --version` ("1.3.3", "opencode 1.3.3",
/// "v2.0.22"). `None` when there is no such run of digits.
fn parse_version(s: &str) -> Option<(u32, u32, u32)> {
    let word = s.split_whitespace().find(|w| {
        w.trim_start_matches(|c: char| !c.is_ascii_digit())
            .starts_with(|c: char| c.is_ascii_digit())
    })?;
    let mut it = word
        .trim_start_matches(|c: char| !c.is_ascii_digit())
        .split('.');
    let major = it.next()?.parse().ok()?;
    let minor = it.next()?.parse().ok()?;
    let patch = it.next().unwrap_or("0").parse().ok()?;
    Some((major, minor, patch))
}

/// `opencode --version`, or `None` when OpenCode is not installed.
fn opencode_version() -> Option<String> {
    let out = Command::new("opencode").arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Which plugin file this machine needs.
fn select_opencode_plugin() -> (&'static str, bool) {
    if LEGACY_OVERRIDE.load(Ordering::Relaxed) {
        return (OPENCODE_PLUGIN_LEGACY, true);
    }
    match opencode_version() {
        Some(out) if needs_legacy_plugin(&out) => (OPENCODE_PLUGIN_LEGACY, true),
        _ => (OPENCODE_PLUGIN, false),
    }
}

// Embedded Pi extension (auto-rewrite)
// Stable code marker used to recognize a modified RTK extension without
// relying on explanatory comments that users may remove. The marker matches
// both the current `pi.exec` call and older stock revisions that imported
// `exec` locally before invoking it.
// SHA-256 hashes of stock Pi extension revisions that may exist on user
// machines, including the current embedded file. Keep historical entries
// when changing the extension so an untouched older install can still be
// removed safely. Hashes are computed after normalizing CRLF to LF and
// trimming trailing whitespace, matching the comparisons below.
// The history-based test below verifies that this list remains append-only
// for every revision in the current checkout's ancestor history.
pub(super) fn resolve_opencode_dir() -> Result<PathBuf> {
    resolve_home_subdir(CONFIG_DIR).map(|p| p.join(OPENCODE_SUBDIR))
}

// Pi coding agent support

/// Return OpenCode plugin path: ~/.config/opencode/plugins/rtk.ts
pub(super) fn opencode_plugin_path(opencode_dir: &Path) -> PathBuf {
    opencode_dir.join(PLUGIN_SUBDIR).join(OPENCODE_PLUGIN_FILE)
}

/// Prepare OpenCode plugin directory and return install path
pub(super) fn prepare_opencode_plugin_path() -> Result<PathBuf> {
    let opencode_dir = resolve_opencode_dir()?;
    let path = opencode_plugin_path(&opencode_dir);
    // Directory creation is deferred to install time (caller guards on dry_run).
    Ok(path)
}

/// Write OpenCode plugin file if missing or outdated
pub(super) fn ensure_opencode_plugin_installed(path: &Path, ctx: InitContext) -> Result<bool> {
    let InitContext { dry_run, .. } = ctx;
    // Ensure parent dir exists (skip in dry-run)
    if !dry_run && let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| {
            format!(
                "Failed to create OpenCode plugin directory: {}",
                parent.display()
            )
        })?;
    }
    let (source, legacy) = select_opencode_plugin();
    if legacy && !dry_run {
        println!("  OpenCode <= 1.3.3 detected: installing the legacy plugin instead.");
    }
    write_if_changed(path, source, "OpenCode plugin", ctx)
}

/// Remove OpenCode plugin file
pub(super) fn remove_opencode_plugin(ctx: InitContext) -> Result<Vec<PathBuf>> {
    let InitContext {
        verbose, dry_run, ..
    } = ctx;
    let opencode_dir = resolve_opencode_dir()?;
    let path = opencode_plugin_path(&opencode_dir);
    let mut removed = Vec::new();

    if path.exists() {
        if dry_run {
            println!("[dry-run] would remove OpenCode plugin: {}", path.display());
        } else {
            // nosemgrep: filesystem-deletion -- expected in hooks/init uninstall-path cleanup and tests.
            fs::remove_file(&path)
                .with_context(|| format!("Failed to remove OpenCode plugin: {}", path.display()))?;
            if verbose > 0 {
                eprintln!("Removed OpenCode plugin: {}", path.display());
            }
        }
        removed.push(path);
    }

    Ok(removed)
}

pub(super) fn run_opencode_only_mode(ctx: InitContext) -> Result<()> {
    let InitContext { dry_run, .. } = ctx;
    let opencode_plugin_path = prepare_opencode_plugin_path()?;
    ensure_opencode_plugin_installed(&opencode_plugin_path, ctx)?;
    if !dry_run {
        println!("\nOpenCode plugin installed (global).\n");
        println!("  OpenCode: {}", opencode_plugin_path.display());
        println!("  Restart OpenCode. Test with: git status\n");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    // Both plugins must stay loadable by their own generation, and both must be
    // embedded — the 2.x loader rejects a callable default and the <= 1.3.3
    // loaders call every export, so only one of the two shapes can be right.
    #[test]
    fn legacy_plugin_is_a_function_default() {
        assert!(OPENCODE_PLUGIN_LEGACY.contains("export default RtkOpenCodePlugin"));
        assert!(OPENCODE_PLUGIN_LEGACY.contains("export const RtkOpenCodePlugin: Plugin = async"));
        assert!(OPENCODE_PLUGIN_LEGACY.contains("\"tool.execute.before\""));
    }

    #[test]
    fn current_plugin_is_an_object_default() {
        assert!(OPENCODE_PLUGIN.contains("const RtkOpenCodePlugin = {"));
        assert!(!OPENCODE_PLUGIN.contains("async ({ $ })"));
    }

    // The 1.3.3 / 1.3.4 split is load-bearing: install the wrong file and OpenCode
    // either refuses to start or silently drops every rewrite.
    #[test]
    fn legacy_split_is_pinned() {
        assert!(needs_legacy_plugin("1.3.3"));
        assert!(needs_legacy_plugin("opencode 1.3.3"));
        assert!(needs_legacy_plugin("1.1.4"));
        assert!(needs_legacy_plugin("0.14.2"));
        assert!(!needs_legacy_plugin("1.3.4"));
        assert!(!needs_legacy_plugin("1.18.34"));
        assert!(!needs_legacy_plugin("2.0.22"));
        // unparsable -> the current plugin, which works on every release
        assert!(!needs_legacy_plugin(""));
        assert!(!needs_legacy_plugin("opencode (unknown)"));
        assert!(!needs_legacy_plugin("v"));
    }

    // One test, because the legacy override is a global and Rust runs tests in
    // parallel: splitting these would race on it.
    #[test]
    fn test_opencode_plugin_install_and_update() {
        let temp = TempDir::new().unwrap();
        let opencode_dir = temp.path().join("opencode");
        let plugin_path = opencode_plugin_path(&opencode_dir);

        fs::create_dir_all(plugin_path.parent().unwrap()).unwrap();
        assert!(!plugin_path.exists());

        let changed =
            ensure_opencode_plugin_installed(&plugin_path, InitContext::default()).unwrap();
        assert!(changed);
        let content = fs::read_to_string(&plugin_path).unwrap();
        assert_eq!(content, OPENCODE_PLUGIN);

        fs::write(&plugin_path, "// old").unwrap();
        let changed_again =
            ensure_opencode_plugin_installed(&plugin_path, InitContext::default()).unwrap();
        assert!(changed_again);
        let content_updated = fs::read_to_string(&plugin_path).unwrap();
        assert_eq!(content_updated, OPENCODE_PLUGIN);

        set_opencode_legacy_override(true);
        let result = ensure_opencode_plugin_installed(&plugin_path, InitContext::default());
        set_opencode_legacy_override(false);
        assert!(result.unwrap());
        let legacy = fs::read_to_string(&plugin_path).unwrap();
        assert_eq!(legacy, OPENCODE_PLUGIN_LEGACY);
        assert_ne!(legacy, OPENCODE_PLUGIN);
    }

    #[test]
    fn test_opencode_plugin_remove() {
        let temp = TempDir::new().unwrap();
        let opencode_dir = temp.path().join("opencode");
        let plugin_path = opencode_plugin_path(&opencode_dir);
        fs::create_dir_all(plugin_path.parent().unwrap()).unwrap();
        fs::write(&plugin_path, OPENCODE_PLUGIN).unwrap();

        assert!(plugin_path.exists());
        // nosemgrep: filesystem-deletion -- expected in hooks/init uninstall-path cleanup and tests.
        fs::remove_file(&plugin_path).unwrap();
        assert!(!plugin_path.exists());
    }

    // Pi integration tests
}
