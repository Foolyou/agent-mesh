export type WorkPacketInput = {
  agentName: string;
  role: string;
  taskId: string;
  task: string;
  mailboxPath: string;
};

export function buildWorkPacket(input: WorkPacketInput): string {
  return [
    "<<<AGENT_ROOM_WORK_PACKET_START>>>",
    "You are running inside an Agent Room PTY prototype.",
    "",
    "Important coordination rule:",
    "Terminal output is treated as observational and may be lossy. The mailbox file is the reliable coordination channel.",
    "",
    `Agent name: ${input.agentName}`,
    `Role: ${input.role}`,
    `Task id: ${input.taskId}`,
    `Mailbox file: ${input.mailboxPath}`,
    "",
    "Task:",
    input.task,
    "",
    "You must send staged progress and the final result to the mailbox.",
    "Use this exact command shape whenever you complete a phase:",
    "",
    `bun run src/mailbox-send.ts --mailbox "${input.mailboxPath}" --from "${input.agentName}" --task-id "${input.taskId}" --type stage --phase planning <<'AGENT_ROOM_BODY'`,
    "short status message",
    "AGENT_ROOM_BODY",
    "",
    "For the final answer use type=result and phase=final:",
    "",
    `bun run src/mailbox-send.ts --mailbox "${input.mailboxPath}" --from "${input.agentName}" --task-id "${input.taskId}" --type result --phase final <<'AGENT_ROOM_BODY'`,
    "final result, decisions, evidence, and next steps",
    "AGENT_ROOM_BODY",
    "",
    "Minimum required mailbox events:",
    "1. stage/planning after you understand the task.",
    "2. stage/working while executing or reasoning.",
    "3. result/final when complete.",
    "",
    "If blocked, send type=blocked with the blocking condition and needed human decision.",
    "Do not rely on terminal-only messages for important progress.",
    "<<<AGENT_ROOM_WORK_PACKET_END>>>",
    "",
  ].join("\n");
}
