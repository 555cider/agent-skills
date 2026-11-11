/**
 * Command-line options shared by dom-picker.mjs and locate-source.mjs.
 *
 * Accepts `--name=value` and `--name value` for value options and bare `--name` for flags.
 * An option the command does not declare is an error, not a silent no-op: a typo such as
 * `--sesion=...` would otherwise run against a different target than the caller meant.
 * `fail(message)` must not return (both callers exit 2).
 */
export function parseOptions(argv, { values = [], flags = [] }, fail) {
  const options = new Map();
  const present = new Set();
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const equals = argument.indexOf("=");
    const name = argument.slice(2, equals >= 0 ? equals : undefined);
    if (values.includes(name)) {
      if (equals >= 0) {
        options.set(name, argument.slice(equals + 1));
      } else {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("--")) fail(`--${name} requires a value`);
        options.set(name, value);
        index += 1;
      }
    } else if (flags.includes(name)) {
      if (equals >= 0) fail(`--${name} takes no value`);
      present.add(name);
    } else {
      const known = [...values, ...flags].map((item) => `--${item}`).join(", ");
      fail(`unknown option --${name}${known ? `; expected one of ${known}` : ""}`);
    }
  }
  return {
    option: (name, fallback = null) => (options.has(name) ? options.get(name) : fallback),
    hasFlag: (name) => present.has(name),
    positionals,
  };
}
