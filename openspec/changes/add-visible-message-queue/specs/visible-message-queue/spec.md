## ADDED Requirements

### Requirement: Queued messages stay outside the transcript
The system SHALL keep queued operator prompts and inter-agent mail out of an agent transcript until the agent starts processing the corresponding turn.

#### Scenario: Busy agent receives a normal message
- **WHEN** an agent is processing one turn and another normal message is queued for that agent
- **THEN** the queued message is represented in the visible queue summary and is not added to the transcript

#### Scenario: Queued message starts
- **WHEN** a queued message starts processing
- **THEN** the queue summary count decreases by one and the message is added to the target agent transcript

### Requirement: Queue box shows compact summary
The Web UI SHALL render a queue box above the composer for each agent conversation that has queued messages.

#### Scenario: Queue has messages
- **WHEN** an agent conversation has one or more queued messages
- **THEN** the composer area shows the queued message count and a one-line plain-text preview of the most recent queued message

#### Scenario: Queue is empty
- **WHEN** an agent conversation has no queued messages
- **THEN** the queue box is not shown

### Requirement: Operator steer is priority queued
The system SHALL queue operator steer messages ahead of ordinary queued messages and interrupt the active turn.

#### Scenario: User steers a busy agent
- **WHEN** the user sends a steer message while the target agent is busy
- **THEN** the steer message is queued ahead of ordinary messages, the active turn is interrupted, and the steer message enters the transcript only when its turn starts
