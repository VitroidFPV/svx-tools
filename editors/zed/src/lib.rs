use std::{env, fs};

use zed_extension_api as zed;

const PACKAGE_NAME: &str = "svx-tools";
const PACKAGE_VERSION: &str = "0.0.1";
const SERVER_PATH: &str = "node_modules/svx-tools/scripts/lsp.ts";

struct SvxExtension;

impl SvxExtension {
    fn server_path(&self, language_server_id: &zed::LanguageServerId) -> zed::Result<String> {
        let path = env::current_dir()
            .map_err(|error| error.to_string())?
            .join(SERVER_PATH);

        if fs::metadata(&path).is_err()
            || zed::npm_package_installed_version(PACKAGE_NAME)?.as_deref()
                != Some(PACKAGE_VERSION)
        {
            zed::set_language_server_installation_status(
                language_server_id,
                &zed::LanguageServerInstallationStatus::Downloading,
            );
            zed::npm_install_package(PACKAGE_NAME, PACKAGE_VERSION)?;
        }

        if !path.is_file() {
            return Err(format!(
                "installed {PACKAGE_NAME}@{PACKAGE_VERSION} is missing scripts/lsp.ts"
            ));
        }

        Ok(path.to_string_lossy().into_owned())
    }
}

impl zed::Extension for SvxExtension {
    fn new() -> Self {
        Self
    }

    fn language_server_command(
        &mut self,
        language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> zed::Result<zed::Command> {
        let bun = worktree
            .which("bun")
            .ok_or("SVX language server requires Bun on Zed's PATH")?;

        let local_checkout = worktree
            .read_text_file("package.json")
            .ok()
            .and_then(|text| zed::serde_json::from_str::<zed::serde_json::Value>(&text).ok())
            .and_then(|package| package.get("name")?.as_str().map(|name| name == PACKAGE_NAME))
            .unwrap_or(false);
        let script = if local_checkout {
            format!("{}/scripts/lsp.ts", worktree.root_path())
        } else {
            self.server_path(language_server_id)?
        };

        Ok(zed::Command {
            command: bun,
            args: vec![script, "--stdio".into()],
            env: worktree.shell_env(),
        })
    }
}

zed::register_extension!(SvxExtension);
