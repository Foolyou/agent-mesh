export type ParsedArgs = {
  values: Record<string, string | boolean>;
  rest: string[];
};

export function parseArgs(argv = process.argv.slice(2)): ParsedArgs {
  const values: Record<string, string | boolean> = {};
  const rest: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--") {
      rest.push(...argv.slice(index + 1));
      break;
    }

    if (!arg.startsWith("--")) {
      rest.push(arg);
      continue;
    }

    const trimmed = arg.slice(2);
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex >= 0) {
      values[trimmed.slice(0, equalsIndex)] = trimmed.slice(equalsIndex + 1);
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      values[trimmed] = next;
      index += 1;
      continue;
    }

    values[trimmed] = true;
  }

  return { values, rest };
}

export function stringArg(
  values: Record<string, string | boolean>,
  key: string,
  fallback: string,
): string {
  const value = values[key];
  return typeof value === "string" ? value : fallback;
}

export function booleanArg(
  values: Record<string, string | boolean>,
  key: string,
): boolean {
  return values[key] === true || values[key] === "true";
}
