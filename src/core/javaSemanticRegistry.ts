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
  { id: "clock", pattern: /LocalDateTime\.now|Instant\.now|System\.currentTimeMillis|Clock\.|new\s+Date\b/i, kind: "clock-read", reason: "runtime clock read", defaultOwnership: "target-owned" },
  { id: "redis", pattern: /RedisTemplate|StringRedisTemplate|opsForValue|opsForHash|redis\.call|RedisScript/i, kind: "coordination", reason: "Redis/cache coordination", defaultOwnership: "infrastructure-port" },
  { id: "async", pattern: /CompletableFuture|ExecutorService|TaskExecutor|\.submit\b|\.execute\b|@Async\b/i, kind: "async-boundary", reason: "asynchronous execution boundary", defaultOwnership: "target-owned" },
  { id: "lambda", pattern: /lambda\s*->|method-reference|::/, kind: "calculation", reason: "Java lambda or method reference", defaultOwnership: "target-owned" },
  { id: "mapping", pattern: /BeanUtils|copyProperties|Convert\.|ObjectMapper|toBean\b/i, kind: "calculation", reason: "DTO/object mapping", defaultOwnership: "reviewed-exclusion" },
  { id: "jdk-pure", pattern: /(?:Objects|Optional|String|Integer|Long|Boolean|Double|BigDecimal|Math|Collections|Arrays|Collectors|Stream)\./, kind: "calculation", reason: "JDK deterministic utility", defaultOwnership: "reviewed-exclusion" }
];

export function classifyJavaSemantic(text: string): JavaSemanticRule | undefined {
  return JAVA_SEMANTIC_RULES.find((rule) => rule.pattern.test(text));
}
