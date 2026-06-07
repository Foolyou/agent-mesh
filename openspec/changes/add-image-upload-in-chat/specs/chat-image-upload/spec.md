## ADDED Requirements

### Requirement: Attach images via paste, drag-and-drop, and file picker

The composer SHALL let the user attach one or more images to a prompt via
clipboard paste, drag-and-drop onto the composer, and a file-picker button, on
every chat surface (master agent, mesh router, individual agent). Pending
attachments SHALL be shown as removable thumbnails before sending.

#### Scenario: Paste an image

- **WHEN** the user pastes image data into the focused composer
- **THEN** the image appears as a pending attachment thumbnail with a remove
  control

#### Scenario: Drag-and-drop and file picker

- **WHEN** the user drops an image file on the composer or selects one via the
  attach button
- **THEN** the image appears as a pending attachment thumbnail with a remove
  control

#### Scenario: Remove a pending attachment

- **WHEN** the user activates the remove control on a pending attachment
- **THEN** that attachment is discarded and not sent

### Requirement: Validate image type, size, and count

Image attachments SHALL be limited to PNG, JPEG, GIF, and WebP, at most 10 MB
each and at most 5 per message. SVG SHALL be rejected. Validation SHALL occur on
the client and SHALL be re-enforced on the server by inspecting file content
(magic bytes), not the filename or client-supplied type.

#### Scenario: Reject disallowed type

- **WHEN** the user attaches an SVG or a non-image file
- **THEN** it is rejected with a clear message and not added as a pending
  attachment

#### Scenario: Reject oversize or excess count

- **WHEN** the user attaches an image over 10 MB, or a 6th image
- **THEN** it is rejected with a clear message

#### Scenario: Server re-validates content

- **WHEN** an upload reaches the server whose actual content is not an allowed
  image type
- **THEN** the server rejects it regardless of the declared filename or type

### Requirement: Upload and store images, referencing them in the prompt

On send, each attached image SHALL be uploaded to the backend and stored once
under `<root>/.agent-mesh/uploads/<bucket>/` where the bucket is the mesh name or
`master`. The prompt payload SHALL carry lightweight references (server-generated
id, mime type, name), not the image bytes. Image bytes SHALL NOT be transmitted
over the live state WebSocket.

#### Scenario: Image is stored and referenced

- **WHEN** the user sends a message with an image
- **THEN** the image is stored under the conversation's bucket and the prompt
  carries a reference to it, while the broadcast transcript carries a URL rather
  than the image bytes

### Requirement: Deliver images to the agent as ACP image content

The prompt turn SHALL carry ACP image content blocks (image type with mime type and base64 data) alongside the text whenever a prompt includes image references and the target agent advertises image support; the image bytes SHALL be read from storage and base64-encoded at the ACP boundary.

#### Scenario: Image reaches the agent

- **WHEN** a prompt with an image is sent to an image-capable agent
- **THEN** the agent receives a prompt turn containing the text and an image
  content block carrying that image

#### Scenario: Missing stored file degrades gracefully

- **WHEN** a referenced image file cannot be read at send time
- **THEN** the turn is still sent with its text (and any readable images), and the
  missing image is skipped with a logged warning

### Requirement: Capability-gate the attach affordance

The attach affordance SHALL be available only for conversations whose agent
advertises `promptCapabilities.image`. For agents without image support, the
affordance SHALL be hidden or disabled with an explanatory tooltip, so a user
cannot compose a turn the agent will reject.

#### Scenario: Non-image agent hides attach

- **WHEN** the active conversation's agent does not advertise image support
- **THEN** the composer does not offer image attachment (and explains why on
  hover)

#### Scenario: Image-capable agent offers attach

- **WHEN** the active conversation's agent advertises image support
- **THEN** the composer offers image attachment

### Requirement: Show sent images in the transcript

A user message that included images SHALL render those images as inline
thumbnails in the user's message bubble, served from the backend by URL.
Activating a thumbnail SHALL open an enlarged view (lightbox).

#### Scenario: Thumbnails appear and enlarge

- **WHEN** a user message with images is shown in the transcript
- **THEN** the bubble shows inline thumbnails, and clicking one opens an enlarged
  view

### Requirement: Upload lifecycle is mesh-scoped

Uploads SHALL be organized by bucket under the root. When a mesh is removed, its
upload bucket SHALL be deleted. The `master` bucket SHALL persist independent of
any mesh.

#### Scenario: Mesh removal cleans up its uploads

- **WHEN** a mesh is removed
- **THEN** the images stored under that mesh's bucket are deleted
