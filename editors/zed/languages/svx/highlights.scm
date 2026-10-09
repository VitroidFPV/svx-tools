(atx_heading (inline) @title.markup)
(setext_heading (paragraph) @title.markup)

[
  (atx_h1_marker)
  (atx_h2_marker)
  (atx_h3_marker)
  (atx_h4_marker)
  (atx_h5_marker)
  (atx_h6_marker)
  (list_marker_plus)
  (list_marker_minus)
  (list_marker_star)
  (list_marker_dot)
  (list_marker_parenthesis)
  (block_quote_marker)
  (fenced_code_block_delimiter)
  (thematic_break)
] @punctuation

(fenced_code_block (info_string (language) @string))
(indented_code_block) @string

; A standalone closer is an unmatched tag in its Svelte injection. Color its
; name here while the injection colors the bracket tokens.
((html_block) @tag.component.type.constructor
  (#match? @tag.component.type.constructor "^</[A-Z][A-Za-z0-9_.:-]*\\s*>\\s*$"))
((inline) @tag.component.type.constructor
  (#match? @tag.component.type.constructor "^</[A-Z][A-Za-z0-9_.:-]*\\s*>\\s*$"))
