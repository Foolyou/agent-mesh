## ADDED Requirements

### Requirement: Agent message and thought text render as markdown

The web console SHALL render agent-authored message text and thought-block text
as markdown. The renderer SHALL support GitHub Flavored Markdown: headings,
ordered and unordered lists, task lists, bold, italic, strikethrough, inline
code, fenced code blocks, blockquotes, tables, horizontal rules, links, and
images.

#### Scenario: Inline emphasis renders as formatted markup

- **WHEN** an agent message contains `**bold**` and `_italic_`
- **THEN** the bubble renders a `<strong>` element and an `<em>` element, not the
  literal asterisk/underscore characters

#### Scenario: Fenced code renders as a code block

- **WHEN** an agent message contains a triple-backtick fenced code block
- **THEN** the bubble renders a `<pre>` containing a `<code>` element with the
  code text preserved

#### Scenario: Lists render as list elements

- **WHEN** an agent message contains a markdown unordered list
- **THEN** the bubble renders a `<ul>` with one `<li>` per item

#### Scenario: Thought blocks render markdown

- **WHEN** an expanded thought block contains markdown
- **THEN** the thought body renders the formatted markup, consistent with agent
  message rendering

### Requirement: User messages and tool output do not render markdown

The web console SHALL render user-authored message text as escaped plain text
with whitespace preserved, and SHALL render tool-call input and output as raw
monospace text. Markdown formatting SHALL NOT be applied to these surfaces.

#### Scenario: User message shows literal markdown syntax

- **WHEN** a user message contains `**bold**`
- **THEN** the bubble displays the literal characters `**bold**` and does not
  render a `<strong>` element

#### Scenario: Tool output stays raw

- **WHEN** a tool card displays input or output text containing markdown-like
  characters
- **THEN** the text is shown verbatim in monospace without markdown conversion

### Requirement: Streaming markdown renders without broken blocks

The renderer SHALL tolerate incomplete markdown produced during token streaming
so that partially received syntax (such as an unclosed code fence or unterminated
emphasis) does not corrupt the rendered output or the surrounding UI.

#### Scenario: Unclosed fence mid-stream does not swallow the UI

- **WHEN** an agent message is still streaming and currently ends with an opened
  but unclosed code fence
- **THEN** the message renders as a code block in progress without consuming or
  breaking other transcript content, and resolves correctly once the closing
  fence arrives

### Requirement: Links are rendered safely

The renderer SHALL NOT emit raw HTML from markdown. Rendered links SHALL open in
a new browsing context with `rel="noopener noreferrer"`. The renderer SHALL only
allow links whose URL scheme is `http` or `https`; links using other schemes
(such as `javascript:`) SHALL NOT be rendered as active links.

#### Scenario: External link is hardened

- **WHEN** an agent message contains an `http(s)` markdown link
- **THEN** the rendered `<a>` has `target="_blank"` and
  `rel="noopener noreferrer"`

#### Scenario: Dangerous scheme is neutralized

- **WHEN** an agent message contains a link with a `javascript:` URL
- **THEN** no active `javascript:` link is produced (the dangerous href is
  dropped or rendered inert)

### Requirement: Images are rendered safely

The renderer SHALL display markdown images. Rendered images SHALL set
`referrerpolicy="no-referrer"` and `loading="lazy"`, SHALL only load sources
whose scheme is `http`, `https`, or `data`, and SHALL be size-constrained so an
image cannot exceed its container width or an established maximum height.

#### Scenario: Remote image is hardened on load

- **WHEN** an agent message contains a remote `https` image
- **THEN** the rendered `<img>` has `referrerpolicy="no-referrer"` and
  `loading="lazy"` and is constrained to at most its container width

#### Scenario: Dangerous image scheme is neutralized

- **WHEN** an agent message contains an image whose source uses a disallowed
  scheme (such as `javascript:`)
- **THEN** no image request is made for that source

### Requirement: Markdown elements are themed and accessible

Rendered markdown elements SHALL be styled using the existing CSS-variable theme
palette and SHALL fit the console's dense layout. Link color SHALL use the
`info` palette role. All foreground/background pairings introduced by markdown
elements SHALL meet the project's WCAG contrast thresholds across every built-in
theme.

#### Scenario: Link color meets contrast in every theme

- **WHEN** the contrast audit runs over all built-in themes
- **THEN** the link color (`info` role) against its background meets the required
  WCAG contrast threshold in every theme

#### Scenario: Markdown does not break autoscroll

- **WHEN** an agent message rendered as markdown changes the transcript content
  height while the view is scrolled to the bottom
- **THEN** the transcript stays pinned to the bottom (existing stick-to-bottom
  behavior is preserved)
