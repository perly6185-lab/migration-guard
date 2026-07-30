local key = KEYS[1]
local mode = ARGV[1]
local owner = ARGV[2]
local now = tonumber(ARGV[3])
local expires_at = tonumber(ARGV[4])
local owner_field = mode .. ":" .. owner
local current = tonumber(redis.call("HGET", key, owner_field))

if current == nil or current <= now then
  redis.call("HDEL", key, owner_field)
  return "OWNER_MISSING"
end

redis.call("HSET", key, owner_field, expires_at)
redis.call("PEXPIREAT", key, expires_at)
return "RENEWED"
