const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SENSITIVE_KEY_PATTERN = /token|secret|api[_-]?key|apikey|password|private[_-]?key|authorization|cookie|session|credential/i;
const SENSITIVE_VALUE_PATTERN = /(bearer\s+)[a-z0-9._~+/=-]+|([?&](?:token|key|secret|password)=)[^&\s]+/gi;

function normalizeLevel(level) {
  const normalized = String(level || '').trim().toLowerCase();
  return LEVELS[normalized] ? normalized : null;
}

const currentLevel = normalizeLevel(process.env.LOG_LEVEL)
  || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

function shouldLog(level) {
  return LEVELS[level] >= LEVELS[currentLevel];
}

function redactString(value) {
  return String(value).replace(SENSITIVE_VALUE_PATTERN, (_match, bearerPrefix, queryPrefix) => {
    if (bearerPrefix) return `${bearerPrefix}[REDACTED]`;
    if (queryPrefix) return `${queryPrefix}[REDACTED]`;
    return '[REDACTED]';
  });
}

function sanitize(value, depth = 0, seen = new WeakSet()) {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      code: value.code,
      status: value.status || value.statusCode,
      stack: process.env.NODE_ENV === 'production' ? undefined : value.stack,
    };
  }

  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object') return value;
  if (depth > 4) return '[Object]';
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitize(item, depth + 1, seen));
  }

  return Object.entries(value).reduce((safe, [key, entry]) => {
    safe[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? '[REDACTED]'
      : sanitize(entry, depth + 1, seen);
    return safe;
  }, {});
}

function write(level, args) {
  if (!shouldLog(level)) return;
  const sanitizedArgs = args.map((arg) => sanitize(arg));
  const target = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  target(...sanitizedArgs);
}

module.exports = {
  debug: (...args) => write('debug', args),
  info: (...args) => write('info', args),
  warn: (...args) => write('warn', args),
  error: (...args) => write('error', args),
  shouldLog,
  sanitize,
  level: currentLevel,
};
