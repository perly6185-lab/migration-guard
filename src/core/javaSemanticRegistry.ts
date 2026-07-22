import type { BehaviorKind } from "./endpointReplacementModel.js";

export interface JavaSemanticRule {
  id: string;
  pattern: RegExp;
  kind: BehaviorKind;
  reason: string;
  defaultOwnership: "target-owned" | "infrastructure-port" | "reviewed-exclusion";
}

export const JAVA_SEMANTIC_RULES: JavaSemanticRule[] = [
  { id: "logging", pattern: /(?:^|\.)(?:log|logger)\.(?:trace|debug|info|warn|error)\b|Slf4j|LoggerFactory/i, kind: "observability", reason: "logging/observability call", defaultOwnership: "reviewed-exclusion" },
  { id: "clock", pattern: /(?:LocalDateTime|LocalDate|LocalTime|DateTime)\.now|Instant\.now|System\.(?:currentTimeMillis|nanoTime)|Clock\.|new\s+Date\b/i, kind: "clock-read", reason: "runtime clock read", defaultOwnership: "target-owned" },
  { id: "redis", pattern: /RedisTemplate|StringRedisTemplate|opsForValue|opsForHash|redis\.call|RedisScript/i, kind: "coordination", reason: "Redis/cache coordination", defaultOwnership: "infrastructure-port" },
  { id: "async", pattern: /CompletableFuture|ExecutorService|TaskExecutor|\.submit\b|\.execute\b|@Async\b/i, kind: "async-boundary", reason: "asynchronous execution boundary", defaultOwnership: "target-owned" },
  { id: "future-wait", pattern: /(?:Future|CompletionStage|\w+Future)\.join\b|\b\w+Future\.get\b/i, kind: "async-boundary", reason: "asynchronous result synchronization", defaultOwnership: "target-owned" },
  { id: "executor-lifecycle", pattern: /\bexecutor\.(?:shutdown|shutdownNow|awaitTermination)\b/i, kind: "async-boundary", reason: "executor lifecycle boundary", defaultOwnership: "target-owned" },
  { id: "in-memory-coordination", pattern: /\b(?:queue\.(?:offer|poll)|barrier\.(?:awaitTurn|signalDone))\b/i, kind: "coordination", reason: "in-memory queue or ordering coordination", defaultOwnership: "target-owned" },
  { id: "sql-session-flush", pattern: /SqlSessionTemplate\.flushStatements\b/i, kind: "state-write", reason: "SQL session write flush", defaultOwnership: "infrastructure-port" },
  { id: "lambda", pattern: /lambda\s*->|method-reference|::/, kind: "calculation", reason: "Java lambda or method reference", defaultOwnership: "target-owned" },
  { id: "mapping", pattern: /BeanUtils|copyProperties|Convert\.|ObjectMapper|toBean\b/i, kind: "calculation", reason: "DTO/object mapping", defaultOwnership: "reviewed-exclusion" },
  { id: "serialization", pattern: /(?:JSON\.(?:toJSON|toJSONString|parseArray|parseObject)|gson\.(?:toJson|fromJson)|ObjectMapper)/i, kind: "calculation", reason: "serialization or deserialization", defaultOwnership: "reviewed-exclusion" },
  { id: "string-builder", pattern: /\.append\b/i, kind: "calculation", reason: "deterministic string construction", defaultOwnership: "reviewed-exclusion" },
  { id: "jdk-stream", pattern: /\.stream\(\)\.(?:filter|map|flatMap|collect|toList|reduce|count|findFirst|findAny|anyMatch|allMatch|noneMatch|sorted|distinct|forEach)\b|\.(?:values|entrySet)\(\)\.forEach\b/, kind: "calculation", reason: "JDK stream or collection traversal", defaultOwnership: "reviewed-exclusion" },
  { id: "jdk-date-value", pattern: /(?:LocalDate|LocalDateTime|LocalTime|YearMonth)\.(?:of|parse)\b|\.(?:atStartOfDay|plusMonths|minusMonths|withDayOfMonth|toLocalDate|toLocalDateTime)\b/, kind: "calculation", reason: "deterministic date/time value operation", defaultOwnership: "reviewed-exclusion" },
  { id: "jdk-pure", pattern: /(?:Objects|Optional|String|Integer|Long|Float|Boolean|Double|BigDecimal|Math|Collections|Arrays|Collectors|Stream|Function|Comparator|DateTimeFormatter|Duration|Pattern)\.|\.(?:length|replace|replaceAll|substring|startsWith|endsWith|trim|matcher|matches|group|indexOf|lastIndexOf|split|charAt|chars|allMatch|toPlainString|intValue|longValue|doubleValue|toLowerCase|toUpperCase|toCharArray|subtract|add|multiply|divide|format)\b/, kind: "calculation", reason: "JDK deterministic utility", defaultOwnership: "reviewed-exclusion" },
  { id: "exception-output", pattern: /\.printStackTrace\b/, kind: "observability", reason: "exception diagnostic output", defaultOwnership: "reviewed-exclusion" },
  { id: "query-builder", pattern: /(?:QueryWrapper|LambdaQueryWrapper|UpdateWrapper|wrapper\w*)\.(?:eq|ne|gt|ge|lt|le|like|in|orderBy|select|set)\b/i, kind: "calculation", reason: "query predicate construction", defaultOwnership: "reviewed-exclusion" },
  { id: "aop-context", pattern: /AopContext\.currentProxy/i, kind: "context-resolution", reason: "Spring proxy context access", defaultOwnership: "infrastructure-port" },
  { id: "progress-report", pattern: /reporter\.reportStage|reportProgress/i, kind: "observability", reason: "progress reporting", defaultOwnership: "target-owned" }
];

export function classifyJavaSemantic(text: string): JavaSemanticRule | undefined {
  return JAVA_SEMANTIC_RULES.find((rule) => rule.pattern.test(text));
}
