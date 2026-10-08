use zed_extension_api as zed;

struct SvxExtension;

impl zed::Extension for SvxExtension {
    fn new() -> Self {
        Self
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> zed::Result<zed::Command> {
        worktree.read_text_file("scripts/lsp.ts").map_err(|_| {
            "SVX prototype: open the svx-tools repository as a Zed worktree".to_string()
        })?;
        let bun = worktree
            .which("bun")
            .ok_or("SVX prototype requires Bun on Zed's PATH")?;

        Ok(zed::Command {
            command: bun,
            args: vec![format!("{}/scripts/lsp.ts", worktree.root_path()), "--stdio".into()],
            env: worktree.shell_env(),
        })
    }
}

zed::register_extension!(SvxExtension);
