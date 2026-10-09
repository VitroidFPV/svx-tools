((inline) @injection.content
  (#not-match? @injection.content "^</?[A-Za-z][A-Za-z0-9:-]*[ >]")
  (#set! injection.language "markdown-inline"))

((inline) @injection.content
  (#match? @injection.content "^</?[A-Za-z][A-Za-z0-9:-]*[ >]")
  (#set! injection.language "svelte"))

((html_block) @injection.content
  (#set! injection.language "svelte"))

((minus_metadata) @injection.content
  (#set! injection.language "yaml"))

(fenced_code_block
  (info_string (language) @injection.language)
  (code_fence_content) @injection.content)
