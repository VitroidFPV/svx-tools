use std::{env, fs};

use zed_extension_api as zed;

const PACKAGE_NAME: &str = "svx-tools";
const PACKAGE_VERSION: &str = "0.0.2";
const SERVER_PATH: &str = "node_modules/svx-tools/dist/lsp.cjs";

struct SvxExtension;

impl SvxExtension {
    fn server_path(&self, language_server_id: &zed::LanguageServerId) -> zed::Result<String> {
        let path = env::current_dir()
            .map_err(|error| error.to_string())?
            .join(SERVER_PATH);

        if fs::metadata(&path).is_err()
            || zed::npm_package_installed_version(PACKAGE_NAME)?.as_deref() != Some(PACKAGE_VERSION)
        {
            zed::set_language_server_installation_status(
                language_server_id,
                &zed::LanguageServerInstallationStatus::Downloading,
            );
            zed::npm_install_package(PACKAGE_NAME, PACKAGE_VERSION)?;
        }

        if !path.is_file() {
            return Err(format!(
                "installed {PACKAGE_NAME}@{PACKAGE_VERSION} is missing dist/lsp.cjs"
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
        let node = zed::node_binary_path()?;

        let local_checkout = worktree
            .read_text_file("package.json")
            .ok()
            .and_then(|text| zed::serde_json::from_str::<zed::serde_json::Value>(&text).ok())
            .and_then(|package| {
                package
                    .get("name")?
                    .as_str()
                    .map(|name| name == PACKAGE_NAME)
            })
            .unwrap_or(false);
        let script = if local_checkout {
            format!("{}/dist/lsp.cjs", worktree.root_path())
        } else {
            self.server_path(language_server_id)?
        };
        let node_modules = if local_checkout {
            format!("{}/node_modules", worktree.root_path())
        } else {
            env::current_dir()
                .map_err(|error| error.to_string())?
                .join("node_modules")
                .to_string_lossy()
                .into_owned()
        };
        let mut env = worktree.shell_env();
        // Svelte's checker otherwise falls back to its Svelte 4 dependency in projects without Svelte.
        let existing_node_path = env
            .iter()
            .find(|(key, _)| key == "NODE_PATH")
            .map(|(_, value)| value.as_str())
            .filter(|value| !value.is_empty());
        let node_path = match existing_node_path {
            Some(existing) => {
                let separator = if zed::current_platform().0 == zed::Os::Windows {
                    ';'
                } else {
                    ':'
                };
                format!("{node_modules}{separator}{existing}")
            }
            None => node_modules,
        };
        env.retain(|(key, _)| key != "NODE_PATH");
        env.push(("NODE_PATH".into(), node_path));

        Ok(zed::Command {
            command: node,
            args: vec![script, "--stdio".into()],
            env,
        })
    }
}

zed::register_extension!(SvxExtension);
